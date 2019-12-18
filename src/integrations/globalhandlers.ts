import { getCurrentHub } from "@sentry/core";
import { Event, Integration, Severity } from "@sentry/types";
import {
  addExceptionMechanism,
  getGlobalObject,
  getLocationHref,
  isErrorEvent,
  isPrimitive,
  isString,
  logger
} from "@sentry/utils";

import { getSDK } from "../crossPlatform";
import { eventFromUnknownInput } from "../eventbuilder";
import { shouldIgnoreOnError } from "../helpers";

const sdk = getSDK();

/** JSDoc */
interface GlobalHandlersIntegrations {
  onerror: boolean;
  onunhandledrejection: boolean;
}

/** Global handlers */
export class GlobalHandlers implements Integration {
  /**
   * @inheritDoc
   */
  public name: string = GlobalHandlers.id;

  /**
   * @inheritDoc
   */
  public static id: string = "GlobalHandlers";

  /** JSDoc */
  private readonly _options: GlobalHandlersIntegrations;

  /** JSDoc */
  private readonly _global: Window = getGlobalObject();

  /** JSDoc */
  private _oldOnErrorHandler: OnErrorEventHandler = null;

  /** JSDoc */
  private _oldOnUnhandledRejectionHandler: ((e: any) => void) | null = null;

  /** JSDoc */
  private _onErrorHandlerInstalled: boolean = false;

  /** JSDoc */
  private _onUnhandledRejectionHandlerInstalled: boolean = false;

  /** JSDoc */
  public constructor(options?: GlobalHandlersIntegrations) {
    this._options = {
      onerror: true,
      onunhandledrejection: true,
      ...options
    };
  }
  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    const currentHub = getCurrentHub();

    Error.stackTraceLimit = 50;

    if (this._options.onerror) {
      logger.log("Global Handler attached: onerror");
      this._installGlobalOnErrorHandler();
    }

    if (this._options.onunhandledrejection) {
      logger.log("Global Handler attached: onunhandledrejection");
      this._installGlobalOnUnhandledRejectionHandler();
    }

    if (!!sdk.onError) {
      logger.log("Global Handler attached: onError");
      sdk.onError((error: string) => {
        // console.log(error)
        console.info("sentry-miniapp", error);
        currentHub.captureException(new Error(error));
      });
    }

    if (!!sdk.onPageNotFound) {
      logger.log("Global Handler attached: onPageNotFound");
      sdk.onPageNotFound((res: { path: string }) => {
        const url = res.path.split("?")[0];

        currentHub.setTag("pagenotfound", url);
        currentHub.setExtra("messaage", JSON.stringify(res));
        currentHub.captureMessage(`页面无法找到: ${url}`);
      });
    }

    if (!!sdk.onMemoryWarning) {
      logger.log("Global Handler attached: onMemoryWarning");
      sdk.onMemoryWarning(({ level = -1 }: { level: number }) => {
        let levelMessage = "没有获取到告警级别信息";

        switch (level) {
          case 5:
            levelMessage = "TRIM_MEMORY_RUNNING_MODERATE";
            break;
          case 10:
            levelMessage = "TRIM_MEMORY_RUNNING_LOW";
            break;
          case 15:
            levelMessage = "TRIM_MEMORY_RUNNING_CRITICAL";
            break;
          default:
            return;
        }

        currentHub.setTag("memory-warning", String(level));
        currentHub.setExtra("message", levelMessage);
        currentHub.captureMessage(`内存不足告警`);
      });
    }
  }

  /** JSDoc */
  private _installGlobalOnErrorHandler(): void {
    if (this._onErrorHandlerInstalled) {
      return;
    }

    const self = this; // tslint:disable-line:no-this-assignment
    this._oldOnErrorHandler = this._global.onerror;

    this._global.onerror = function(
      msg: any,
      url: any,
      line: any,
      column: any,
      error: any
    ): boolean {
      const currentHub = getCurrentHub();
      const hasIntegration = currentHub.getIntegration(GlobalHandlers);
      const isFailedOwnDelivery =
        error && error.__sentry_own_request__ === true;

      if (!hasIntegration || shouldIgnoreOnError() || isFailedOwnDelivery) {
        if (self._oldOnErrorHandler) {
          return self._oldOnErrorHandler.apply(this, arguments);
        }
        return true;
      }

      const client = currentHub.getClient();
      const event = isPrimitive(error)
        ? self._eventFromIncompleteOnError(msg, url, line, column)
        : self._enhanceEventWithInitialFrame(
            eventFromUnknownInput(error, undefined, {
              attachStacktrace: client && client.getOptions().attachStacktrace,
              rejection: false
            }),
            url,
            line,
            column
          );

      addExceptionMechanism(event, {
        handled: false,
        type: "onerror"
      });

      currentHub.captureEvent(event, {
        originalException: error
      });

      if (self._oldOnErrorHandler) {
        return self._oldOnErrorHandler.apply(this, arguments);
      }

      return true;
    };

    this._onErrorHandlerInstalled = true;
  }

  /** JSDoc */
  private _installGlobalOnUnhandledRejectionHandler(): void {
    if (this._onUnhandledRejectionHandlerInstalled) {
      return;
    }

    const self = this; // tslint:disable-line:no-this-assignment
    this._oldOnUnhandledRejectionHandler = this._global.onunhandledrejection;

    this._global.onunhandledrejection = function(e: any): boolean {
      let error = e;
      try {
        error = e && "reason" in e ? e.reason : e;
      } catch (_oO) {
        // no-empty
      }

      const currentHub = getCurrentHub();
      const hasIntegration = currentHub.getIntegration(GlobalHandlers);
      const isFailedOwnDelivery =
        error && error.__sentry_own_request__ === true;

      if (!hasIntegration || shouldIgnoreOnError() || isFailedOwnDelivery) {
        if (self._oldOnUnhandledRejectionHandler) {
          return self._oldOnUnhandledRejectionHandler.apply(this, arguments);
        }
        return true;
      }

      const client = currentHub.getClient();
      const event = isPrimitive(error)
        ? self._eventFromIncompleteRejection(error)
        : eventFromUnknownInput(error, undefined, {
            attachStacktrace: client && client.getOptions().attachStacktrace,
            rejection: true
          });

      event.level = Severity.Error;

      addExceptionMechanism(event, {
        handled: false,
        type: "onunhandledrejection"
      });

      currentHub.captureEvent(event, {
        originalException: error
      });

      if (self._oldOnUnhandledRejectionHandler) {
        return self._oldOnUnhandledRejectionHandler.apply(this, arguments);
      }

      return true;
    };

    this._onUnhandledRejectionHandlerInstalled = true;
  }

  /**
   * This function creates a stack from an old, error-less onerror handler.
   */
  private _eventFromIncompleteOnError(
    msg: any,
    url: any,
    line: any,
    column: any
  ): Event {
    const ERROR_TYPES_RE = /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i;

    // If 'message' is ErrorEvent, get real message from inside
    let message = isErrorEvent(msg) ? msg.message : msg;
    let name;

    if (isString(message)) {
      const groups = message.match(ERROR_TYPES_RE);
      if (groups) {
        name = groups[1];
        message = groups[2];
      }
    }

    const event = {
      exception: {
        values: [
          {
            type: name || "Error",
            value: message
          }
        ]
      }
    };

    return this._enhanceEventWithInitialFrame(event, url, line, column);
  }

  /**
   * This function creates an Event from an TraceKitStackTrace that has part of it missing.
   */
  private _eventFromIncompleteRejection(error: any): Event {
    return {
      exception: {
        values: [
          {
            type: "UnhandledRejection",
            value: `Non-Error promise rejection captured with value: ${error}`
          }
        ]
      }
    };
  }

  /** JSDoc */
  private _enhanceEventWithInitialFrame(
    event: Event,
    url: any,
    line: any,
    column: any
  ): Event {
    event.exception = event.exception || {};
    event.exception.values = event.exception.values || [];
    event.exception.values[0] = event.exception.values[0] || {};
    event.exception.values[0].stacktrace =
      event.exception.values[0].stacktrace || {};
    event.exception.values[0].stacktrace.frames =
      event.exception.values[0].stacktrace.frames || [];

    const colno = isNaN(parseInt(column, 10)) ? undefined : column;
    const lineno = isNaN(parseInt(line, 10)) ? undefined : line;
    const filename = isString(url) && url.length > 0 ? url : getLocationHref();

    if (event.exception.values[0].stacktrace.frames.length === 0) {
      event.exception.values[0].stacktrace.frames.push({
        colno,
        filename,
        function: "?",
        in_app: true,
        lineno
      });
    }

    return event;
  }
}

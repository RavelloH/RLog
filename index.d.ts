type Tostringable = string | null | boolean | undefined | number | bigint;

/**
 * rlog-js
 * @license MIT
 */
declare namespace Rlog {
  interface CustomColorRule {
    reg: string;
    color: string;
  }

  class Config {
    enableColorfulOutput: boolean;
    logFilePath?: string;
    timeFormat: string;
    joinChar: string;
    timezone?: string;
    autoInit: boolean;
    silent: boolean;
    blockedWordsList: string[];
    customColorRules: CustomColorRule[];
    setConfig(obj?: Partial<Config>): void;
    setConfigGlobal(obj?: Partial<Config>): void;
    screenLength: number;
  }

  class Toolkit {
    constructor(config: Config);
    config: Config;
    screen: Screen;
    async checkLogFile(path: string): Promise<void>;
    colorizeString(str: string): string;
    formatTime(): string | number;
    encryptPrivacyContent(str: string): string;
    colorizeType(variable: any): string;
    padLines(str: string, width: number): string;
    stringify(obj: any): string;
  }

  class Screen {
    constructor(toolkit: Toolkit);
    toolkit: Toolkit;
    info(message: any, time?: Tostringable): void;
    warning(message: any, time?: Tostringable): void;
    warn(message: any, time?: Tostringable): void;
    error(message: any, time?: Tostringable): void;
    success(message: any, time?: Tostringable): void;
    exit(message: any, time?: Tostringable): void;
  }

  class File {
    constructor(toolkit: Toolkit, config: Config, screen: Screen);
    config: Config;
    toolkit: Toolkit;
    screen: Screen;
    logStream: NodeJS.WriteStream;
    init(): void;
    writeLogToStream(text: string): Promise<void>;
    writeLog(text: string): void;
    info(message: any, time?: Tostringable): void;
    warning(message: any, time?: Tostringable): void;
    warn(message: any, time?: Tostringable): void;
    warn(message: any, time?: Tostringable): void;
    error(message: any, time?: Tostringable): void;
    success(message: any, time?: Tostringable): void;
    exit(message: any, time?: Tostringable): void;
  }
}
declare class Rlog {
  static Config: typeof Rlog.Config;
  static Toolkit: typeof Rlog.Toolkit;
  static Screen: typeof Rlog.Screen;
  static File: typeof Rlog.File;
  constructor(config?: Partial<Rlog.Config>);
  config: Rlog.Config;
  toolkit: Rlog.Toolkit;
  screen: Rlog.Screen;
  file: Rlog.File;
  info(...messages: any[]): void;
  warning(...messages: any[]): void;
  warn(...messages: any[]): void;
  error(...messages: any[]): void;
  success(...messages: any[]): void;
  async exit(message: any): Promise<never>;
  log(...messages: any[]): void;
  progress(num: number, max: number): void;
  onExit(callback: () => void): void;
  exitListeners: (() => void)[];
}

export = Rlog;

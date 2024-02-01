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
    timezone: string;
    blockedWordsList: string[];
    customColorRules: CustomColorRule[];
    setConfig(obj?: Partial<Config>): void;
    setConfigGlobal(obj?: Partial<Config>): void;
  }

  class Toolkit {
    constructor(config: Config);
    config: Config;
    screen: Screen;
    checkLogFile(path: string): Promise<void>;
    colorizeString(str: string): string;
    formatTime(): string;
    encryptPrivacyContent(str: string): string;
    colorizeType(variable: any): string;
    padLines(str: string, width: number): string;
  }

  class Screen {
    constructor(toolkit: Toolkit);
    toolkit: Toolkit;
    info(message: any, time?: string): void;
    warning(message: any, time?: string): void;
    error(message: any, time?: string): void;
    success(message: any, time?: string): void;
    exit(message: any, time?: string): void;
  }

  class File {
    constructor(toolkit: Toolkit, config: Config, screen: Screen);
    config: Config;
    toolkit: Toolkit;
    screen: Screen;
    logStream: NodeJS.WriteStream;
    init(): void;
    writeLogToStream(text: string): Promise<void>;
    wirteLog(text: string): void;
    info(message: any, time?: string): void;
    warning(message: any, time?: string): void;
    error(message: any, time?: string): void;
    success(message: any, time?: string): void;
    exit(message: any, time?: string): void;
  }
}
declare class Rlog {
  constructor(config?: Rlog.Config);
  config: Rlog.Config;
  toolkit: Rlog.Toolkit;
  screen: Screen;
  file: File;
  info(message: any): void;
  warning(message: any): void;
  error(message: any): void;
  success(message: any): void;
  exit(message: any): Promise<never>;
  log(message: any): void;
  onExit(callback: () => void): void;
  exitListeners: (() => void)[];
}

export = Rlog;

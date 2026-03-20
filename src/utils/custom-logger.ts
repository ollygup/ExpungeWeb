// workers ignore environment.ts/environment.prod.ts replacement done by angular
// so use this instead
declare const IS_PROD: boolean;

export const customLogger = {
  log:   IS_PROD ? () => {} : console.log.bind(console),
  debug: IS_PROD ? () => {} : console.debug.bind(console),
  warn:  IS_PROD ? () => {} : console.warn.bind(console),
  info:  IS_PROD ? () => {} : console.info.bind(console),
  error: console.error.bind(console),
};
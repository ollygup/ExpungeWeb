import { environment } from "../environments/environment";

export const customLogger = {
    log: environment.production ? () => { } : console.log.bind(console),
    debug: environment.production ? () => { } : console.debug.bind(console),
    warn: environment.production ? () => { } : console.warn.bind(console),
    info: environment.production ? () => { } : console.info.bind(console),
    error: console.error.bind(console), // always on
};

import { MAX_NAME } from "./constants.ts";

/*
    Strips control and format characters, which is what smuggles ANSI escapes into the
    operator's terminal and bidi overrides into the panel. Ordinary Unicode survives.
*/
export function clean(value: unknown, max: number = MAX_NAME): string {
    return String(value ?? "")
        .replace(/\p{C}/gu, "")
        .slice(0, max)
        .trim();
}

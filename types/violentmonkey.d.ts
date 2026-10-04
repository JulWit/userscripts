/**
 * @fileoverview Declarations for the Violentmonkey APIs used by the scripts,
 * so that the editor and `tsc -p jsconfig.json` can type-check them. Only the
 * functions granted via @grant somewhere in scripts/ are listed.
 * See https://violentmonkey.github.io/api/gm/.
 */

declare function GM_getValue(key: string, defaultValue?: any): any;
declare function GM_setValue(key: string, value: any): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_addValueChangeListener(
    name: string,
    callback: (name: string, oldValue: any, newValue: any,
        remote: boolean) => void): string;
declare function GM_registerMenuCommand(
    caption: string, onClick: (event: MouseEvent | KeyboardEvent) => void,
    options?: {id?: string, title?: string, autoClose?: boolean}): string;

/** Set by the unit tests before loading a script (see tests/). */
declare var dealScoreTestHook: ((core: object) => void) | undefined;
declare var readingRulerTestHook: ((core: object) => void) | undefined;

interface Window {
  /** Debug handle of the Steam Deal Score script. */
  DealScore?: object;
}

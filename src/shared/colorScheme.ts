// Dark mode for the PDF preview. Shared by the extension host and the viewer webview.

export type ColorScheme = 'light' | 'dark' | 'auto';

export function parseColorScheme(value: unknown): ColorScheme {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

/** VS Code puts the theme kind on the webview's body as `data-vscode-theme-kind`. */
export function isDarkThemeKind(kind: string | undefined): boolean {
  return kind === 'vscode-dark' || kind === 'vscode-high-contrast';
}

/** Whether the pages are drawn dark: always for `dark`, with a dark or high contrast theme for `auto`. */
export function isDarkScheme(scheme: ColorScheme, themeIsDark: boolean): boolean {
  return scheme === 'dark' || (scheme === 'auto' && themeIsDark);
}

/** The toolbar button flips what is on screen, so `auto` becomes the opposite of what it shows now. */
export function toggledScheme(scheme: ColorScheme, themeIsDark: boolean): ColorScheme {
  return isDarkScheme(scheme, themeIsDark) ? 'light' : 'dark';
}

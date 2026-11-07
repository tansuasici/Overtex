import { describe, expect, it } from 'vitest';
import { isDarkScheme, isDarkThemeKind, parseColorScheme, toggledScheme } from '../src/shared/colorScheme';

describe('PDF color scheme', () => {
  it('parses the setting, falling back to light', () => {
    expect(parseColorScheme('dark')).toBe('dark');
    expect(parseColorScheme('auto')).toBe('auto');
    expect(parseColorScheme('light')).toBe('light');
    expect(parseColorScheme('sepia')).toBe('light');
    expect(parseColorScheme(undefined)).toBe('light');
  });

  it('treats dark and high contrast dark themes as dark', () => {
    expect(isDarkThemeKind('vscode-dark')).toBe(true);
    expect(isDarkThemeKind('vscode-high-contrast')).toBe(true);
    expect(isDarkThemeKind('vscode-light')).toBe(false);
    expect(isDarkThemeKind('vscode-high-contrast-light')).toBe(false);
    expect(isDarkThemeKind(undefined)).toBe(false);
  });

  it('follows the theme only in auto', () => {
    expect(isDarkScheme('dark', false)).toBe(true);
    expect(isDarkScheme('light', true)).toBe(false);
    expect(isDarkScheme('auto', true)).toBe(true);
    expect(isDarkScheme('auto', false)).toBe(false);
  });

  it('toggles to the opposite of what is shown', () => {
    expect(toggledScheme('light', true)).toBe('dark');
    expect(toggledScheme('dark', false)).toBe('light');
    expect(toggledScheme('auto', true)).toBe('light');
    expect(toggledScheme('auto', false)).toBe('dark');
  });
});

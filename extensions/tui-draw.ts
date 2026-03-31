/**
 * tui-draw — Reusable TUI drawing primitives for pi extensions.
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

export interface CardTheme {
  bg: string;   // ANSI bg escape
  br: string;   // ANSI fg escape for borders
}

export interface RenderCardOptions {
  title: string;
  content?: string;
  footer?: string;
  colWidth: number;
  theme: {
    fg: (style: string, text: string) => string;
    bold: (text: string) => string;
    [key: string]: any;
  };
  cardTheme: CardTheme;
}

/**
 * Render a bordered card as an array of ANSI-styled lines.
 *
 * Each line is exactly `colWidth` visible characters wide (including borders).
 */
export function renderCard(opts: RenderCardOptions): string[] {
  const { title, content, footer, colWidth, theme, cardTheme } = opts;
  const w = colWidth - 2; // inner width (minus left+right border)
  const { bg, br } = cardTheme;

  const bord = (s: string) => bg + br + s + BG_RESET + FG_RESET;

  const borderLine = (text: string) => {
    const visLen = visibleWidth(text);
    const pad = " ".repeat(Math.max(0, w - visLen));
    return bord("│") + bg + text + bg + pad + BG_RESET + bord("│");
  };

  const top = "┌" + "─".repeat(w) + "┐";
  const bot = "└" + "─".repeat(w) + "┘";

  const lines: string[] = [bord(top)];

  // Title — truncate raw text, then style
  const truncTitle = truncateToWidth(title, w - 1);
  const styledTitle = theme.fg("accent", theme.bold(truncTitle));
  lines.push(borderLine(" " + styledTitle));

  // Content (defaults to "ready" muted) — supports multi-line
  const contentText = content ?? "ready";
  for (const cLine of contentText.split("\n")) {
    const truncContent = truncateToWidth(cLine, w - 1);
    const styledContent = theme.fg("muted", truncContent);
    lines.push(borderLine(" " + styledContent));
  }

  // Optional footer — truncate then style
  if (footer !== undefined) {
    const truncFooter = truncateToWidth(footer, w - 1);
    const styledFooter = theme.fg("muted", truncFooter);
    lines.push(borderLine(" " + styledFooter));
  }

  lines.push(bord(bot));
  return lines;
}

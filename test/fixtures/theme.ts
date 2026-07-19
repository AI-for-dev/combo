/**
 * A complete `Theme` for render tests.
 *
 * `Theme.fg` throws on a colour it does not know, so a partial stub fails on
 * the first unusual colour rather than on a real defect. Building a full one is
 * cheap, and it keeps the tests off pi's internal theme singleton - which is
 * not exported from the package root, and would be a path we have no business
 * depending on.
 */

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

type ThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

const FG: ThemeColor[] = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
	"syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];

const BG: ThemeBg[] = [
	"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
];

/** Every colour defined, all the same value - we assert on text, not on colour. */
export function testTheme(): Theme {
	const fg = Object.fromEntries(FG.map((color) => [color, "#ffffff"])) as Record<ThemeColor, string>;
	const bg = Object.fromEntries(BG.map((color) => [color, "#000000"])) as Record<ThemeBg, string>;
	return new Theme(fg, bg, "256color" as never);
}

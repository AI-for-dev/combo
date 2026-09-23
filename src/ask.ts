/**
 * Asking the *user* a question - the one place a workflow may block on a human.
 *
 * This is a port, not an implementation: no pi, no terminal, no readline. The
 * extension supplies a pi dialog, an example supplies readline, a test supplies
 * a scripted array. That is the same rule as everywhere else here (a feature
 * must work from a script before it is exposed in the TUI), applied to input
 * rather than to display.
 *
 * The shape is deliberately Claude Code's: **one question at a time**, a handful
 * of concrete options, free text always available, and a way to say "enough,
 * get on with it".
 */

/** One proposed answer. `description` says what picking it implies. */
export type Choice = {
	/** What the user reads and picks. A few words, not a sentence. */
	label: string;
	/** What choosing it commits to, when the label alone leaves that open. */
	description?: string;
};

/** One question, in the shape a card can draw and a script can answer. */
export type Question = {
	/** Very short label for the question - a chip, not a sentence. */
	header?: string;
	/** The question itself, asked whole - it is also what a transcript keeps. */
	question: string;
	/** Two to four concrete, mutually exclusive options. */
	options: Choice[];
};

/** What came back: the question, the answer, and whether it was typed or picked. */
export type Answer = {
	/** The question as it was asked, so a transcript reads on its own. */
	question: string;
	/** A choice's `label`, or free text when `custom`. */
	answer: string;
	/** True when the user typed their own answer instead of picking one. */
	custom: boolean;
};

/** A value shown above a question, under its name, so the person answers knowing what it is about. */
export type Shown = {
	/** The address it was read from, as the section's title. */
	readonly name: string;
	/** What it holds: a text as it is, a typed value as JSON, `""` when there is nothing. */
	readonly body: string;
};

/**
 * How a question is put, beyond the question itself: what a flow's `ask`
 * node says of its card. Nothing said is the interview's card.
 */
export type Asking = {
	/**
	 * What the card takes. `open`, the default: one of the options, or a typed
	 * answer (`custom`). `closed`: one of the options only. `confirm`: yes or
	 * no, answered `"yes"` or `"no"`. `text`: a typed answer, `""` when left
	 * empty.
	 */
	readonly form?: "open" | "closed" | "confirm" | "text";
	/** Shown above the question, in order. */
	readonly context?: readonly Shown[];
	/** The visit path of whoever asks, when more than one may. */
	readonly visit?: string;
	/**
	 * The label of "that's enough". Absent: offered, in the card's own words.
	 * `false`: not offered, and declining is the run's stop.
	 */
	readonly enough?: string | false;
	/** Aborted when the question no longer stands, a timeout or a stop: the card closes, and its answer is not read. */
	readonly signal?: AbortSignal;
};

/**
 * Puts one question to the user.
 *
 * Returning `undefined` is the person declining. Where "that's enough" is
 * offered, it is **the submit**: the user has decided there is enough to go
 * on. It is not an error and not a cancellation of what came before - every
 * answer already given still counts. Where it is not, it is the stop.
 */
export type AskUser = (question: Question, asking?: Asking) => Promise<Answer | undefined>;

/**
 * An `AskUser` that replays a script, for tests and non-interactive runs.
 *
 * Runs out of answers → returns `undefined`, which reads as "submit": a script
 * that says nothing more ends the interview instead of hanging it.
 */
export function scriptedAsk(answers: readonly string[]): AskUser & { asked: Question[] } {
	const asked: Question[] = [];
	let index = 0;

	const ask: AskUser = async (question) => {
		asked.push(question);
		const answer = answers[index++];
		if (answer === undefined) return undefined;
		return { question: question.question, answer, custom: !question.options.some((choice) => choice.label === answer) };
	};

	return Object.assign(ask, { asked });
}

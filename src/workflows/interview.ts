/**
 * `interview`: a conversation with the *user*, ending in a brief.
 *
 * Every other combinator here composes agents. This one puts a human in the
 * loop: an agent asks one question at a time through the {@link AskUser} port,
 * and turns the answers into the specification the rest of the pipeline works
 * from.
 *
 * Why one question at a time rather than a form: a good second question depends
 * on the first answer. A form has to guess all of them up front, and guesses
 * wrong the moment the first answer surprises it.
 */

import type { Agent } from "./../agent.ts";
import type { Answer, AskUser, Choice, Question } from "./../ask.ts";
import type { WorkflowResult } from "./../result.ts";
import { jsonObjects, saysWord } from "./../text.ts";
import type { WorkflowOptions } from "./options.ts";
import { SubagentPool } from "./pool.ts";

/** The agent says this - alone - when it has enough to write the brief. */
export const READY = "READY";

/**
 * Answer the user in the language they wrote in - and the two things that must
 * not follow.
 *
 * The questions are read by the person being asked, and one they read less
 * precisely is one they answer less precisely. The specification is read by them
 * too: they are the last person who gets to correct it, and it is written down
 * for agents whose prompts are English but who take a request in any language
 * without trouble.
 *
 * The header is named with the rest because it is drawn above the question, in
 * the same card, by the same person's eye: measured, a French interview came
 * back with `[Cache type]` over "Quel type de stockage ?" until the sentence
 * said so.
 *
 * The exceptions are not decoration. `parseQuestion` reads the JSON by its
 * **keys**, so a translated `options` is a question nobody can display; and the
 * loop ends on {@link READY}, so a model told to write French writes `PRÊT`,
 * which is an interview that never finishes.
 */
const SPEAK_THEIR_LANGUAGE = [
	"Write your headers, your questions, your options and the specification in the language the request above is written in.",
	`The JSON keys stay exactly as given - "header", "question", "options", "label", "description" - and ${READY} stays ${READY}.`,
].join("\n");

/** Who asks, what about, how it reaches the user, and when it must stop. */
export type InterviewOptions = WorkflowOptions & {
	/** The agent conducting the interview. */
	agent: Agent;
	/** What the user asked for, in their own words. */
	input: string;
	/** How questions reach the user. See {@link AskUser}. */
	ask: AskUser;
	/**
	 * Hard cap on questions. Defaults to 6.
	 *
	 * The same reasoning as `loop`'s `maxIterations`, with a human on the other
	 * end: an agent that keeps finding one more thing to clarify is the normal
	 * failure mode, and being interrogated forever is worse than a slightly
	 * under-specified brief.
	 */
	maxQuestions?: number;
	/** Overrides how a question is read. See {@link parseQuestion}. */
	parse?: (output: string) => Question | undefined;
};

/**
 * The brief, and everything that led to it.
 *
 * As a `Result`: the interviewer's last turn, whose `output` is the brief.
 * `usage` covers every turn, the brief included; `ok` says every turn ran, and
 * a short brief can still be `true`.
 */
export type InterviewResult = WorkflowResult & {
	/** The consolidated specification - `output`, under the name the rest of the pipeline reads. */
	brief: string;
	/** Everything the user answered, in order. */
	answers: Answer[];
	/** True when the user submitted before the agent said it was done. */
	submitted: boolean;
};

/**
 * Interviews the user, then asks the agent to write the brief.
 *
 * The lifetime defaults to `"workflow"`, and that is not an arbitrary choice: an
 * interview *is* a conversation. A `"task"` interviewer would forget the answer
 * it just received and ask around it forever.
 *
 * The interview ends when the agent says {@link READY}, when the user submits
 * (`ask` returns `undefined`), or at `maxQuestions` - and in all three cases the
 * agent still writes a brief from what it has. Stopping early is a legitimate
 * outcome, not a failure: a brief written from two answers is worth more than
 * an interrogation nobody finished.
 */
export async function interview(options: InterviewOptions): Promise<InterviewResult> {
	const { agent, input, ask } = options;
	const maxQuestions = options.maxQuestions ?? 6;
	const parse = options.parse ?? parseQuestion;

	const answers: Answer[] = [];
	let submitted = false;

	// An interview is a conversation: the interviewer keeps its memory unless
	// the caller insists otherwise. After the spread, not before: an explicit
	// `undefined` from a merging caller must not read as a choice.
	const pool = new SubagentPool({ ...options, lifetime: options.lifetime ?? "workflow" });
	// The last turn speaks for the interview: the brief when it was written,
	// the turn that failed otherwise.
	const outcome = (brief: string, ok: boolean, error?: string): InterviewResult => ({
		agent: agent.name,
		output: brief,
		messages: pool.trail.steps.at(-1)?.messages ?? [],
		...(error === undefined ? {} : { error }),
		brief,
		answers,
		steps: pool.trail.steps,
		submitted,
		usage: pool.trail.usage(),
		ok,
	});

	try {
		// Held, not turned: the interviewer has to remember what it asked. An
		// interview already called off is refused by the hold, before any spawn.
		const interviewer = await pool.hold(agent);
		let turn = questionPrompt(input, maxQuestions);

		for (let asked = 0; asked < maxQuestions; asked++) {
			const result = await interviewer.ask(turn);
			if (!result.ok) return outcome("", false, result.error);

			if (isReady(result.output)) break;

			const question = parse(result.output);
			if (!question) {
				// Not a failure: an agent that answers with prose has, in
				// practice, said what it wanted to say. Ask it to conclude.
				break;
			}

			const answer = await ask(question);
			if (!answer) {
				submitted = true;
				break;
			}

			answers.push(answer);
			turn = answerPrompt(answer, maxQuestions - asked - 1);
		}

		const final = await interviewer.ask(briefPrompt(input, answers));
		return final.ok ? outcome(final.output, true) : outcome("", false, final.error);
	} finally {
		await pool.closeAll();
	}
}

/** `READY` on its own line, whatever decoration the model put around it. */
function isReady(output: string): boolean {
	return saysWord(output, READY);
}

/** The opening turn: what the user wants, and how to ask about it. */
export function questionPrompt(input: string, maxQuestions: number): string {
	return [
		"A user wants the following:",
		"",
		input.trim(),
		"",
		`Ask them at most ${maxQuestions} questions, one at a time, to pin down what they actually want.`,
		"Ask about what only they can answer - a decision, a preference, a constraint.",
		"Never ask what you could find out by reading the repository yourself.",
		"",
		'Answer with one JSON object only: {"header": "two words", "question": "…", "options": [{"label": "…", "description": "…"}]}',
		"Two to four options, concrete and mutually exclusive. Put the one you would recommend first.",
		// The card draws a label and its description on one line, and pi-tui cuts
		// what does not fit with no ellipsis: measured, `…before r` was the end of
		// an option on a 120-column terminal, and nothing said a word was missing.
		// Asked for here rather than in `agents/interviewer.md`, because the width
		// belongs to the card and the rule has to reach an interviewer a user wrote.
		"Keep a label under 30 characters and a description under 60: they share one line, and what overflows is cut.",
		`When you know enough to write the specification, answer with ${READY} alone instead.`,
		"",
		SPEAK_THEIR_LANGUAGE,
	].join("\n");
}

/** What the user answered, and how much room is left. */
export function answerPrompt(answer: Answer, remaining: number): string {
	return [
		`The user answered: ${answer.answer}`,
		answer.custom ? "(they wrote that themselves rather than picking an option)" : "",
		"",
		remaining > 0
			? `Ask the next question in the same JSON form, or answer ${READY} if you know enough.`
			: `That was the last question. Answer ${READY}.`,
		"",
		SPEAK_THEIR_LANGUAGE,
	]
		.filter(Boolean)
		.join("\n");
}

/** The closing turn: turn the conversation into a specification. */
export function briefPrompt(input: string, answers: readonly Answer[]): string {
	const transcript = answers.length
		? answers.map((answer, index) => `${index + 1}. ${answer.question}\n   → ${answer.answer}`).join("\n")
		: "(the user answered nothing: work from their request alone)";

	return [
		"Write the specification now. It is the only thing the agents doing the work will read:",
		"they will not see this conversation, and they cannot ask you anything.",
		"",
		"Original request:",
		input.trim(),
		"",
		"What the user answered:",
		transcript,
		"",
		"Write it as: the goal in one or two sentences, then what must be done, then what is",
		"explicitly out of scope, then how anyone can tell it is finished.",
		"State decisions as decisions. Do not hedge, do not offer alternatives, do not ask anything.",
		"",
		SPEAK_THEIR_LANGUAGE,
	].join("\n");
}

/**
 * Reads one question out of whatever the agent actually wrote.
 *
 * Same decision as `parsePlan`, for the same reason: the input is a language
 * model, so this is lenient about shape - fenced, wrapped in prose, an array
 * with one object in it - and strict about content. No `question` string, or no
 * usable option, means no question: the caller moves on to the brief rather
 * than putting a malformed card in front of the user.
 */
export function parseQuestion(output: string): Question | undefined {
	for (const block of jsonObjects(output)) {
		const raw = block as { header?: unknown; question?: unknown; options?: unknown };
		if (typeof raw.question !== "string" || !raw.question.trim()) continue;

		const options = readChoices(raw.options);
		if (options.length === 0) continue;

		return {
			header: typeof raw.header === "string" && raw.header.trim() ? raw.header.trim() : undefined,
			question: raw.question.trim(),
			options,
		};
	}
	return undefined;
}

/** Options as objects, or as plain strings - both happen. */
function readChoices(value: unknown): Choice[] {
	if (!Array.isArray(value)) return [];

	const choices: Choice[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim()) {
			choices.push({ label: entry.trim() });
			continue;
		}
		const option = entry as { label?: unknown; description?: unknown };
		if (typeof option?.label === "string" && option.label.trim()) {
			choices.push({
				label: option.label.trim(),
				description: typeof option.description === "string" ? option.description.trim() : undefined,
			});
		}
	}
	return choices;
}


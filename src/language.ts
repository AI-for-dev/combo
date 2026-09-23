/**
 * The language a subagent answers in: the one it was asked in.
 *
 * An agent definition is English, like everything written into this repository,
 * and a model reading an English prompt answers in English whatever the task
 * said. So a French question to `/step scout` came back in English, and the
 * person who asked it had to read their own repository through a translation.
 * That is a defect of the standing prompt, not of the agent: no definition here
 * asks for English, they simply inherit it from the prompt around them.
 *
 * The instruction is therefore standing, like {@link situate}: every subagent
 * gets it, including one written by a user who never thought about the
 * question. It inherits nothing from anybody's environment - it is a constant
 * sentence, the same for every spawn.
 *
 * **It names no language, and that is load-bearing.** An earlier wording made
 * its point with an example - *if the work is in French, answer in French* -
 * and the next English question came back in French. A sentence sitting in
 * front of the model on every turn of every agent has its example read as the
 * target, so the rule points at the work and stops there. That holds for the
 * prompt's own language too: a wording saying the prompt and its framing "are
 * always written in English" was read as "do not answer in English", and an
 * English task to a test reader came back in French four times in six.
 * Without the word, twelve English tasks across two agents came back in
 * English and eight French ones in French.
 *
 * **The English is in the turn, not only in the prompt.** A combinator frames
 * the work it hands over - which round this is, what is new on the board, what
 * is still free to take - and that framing arrives in the *same message* as the
 * task, which a model weighs far above anything standing behind it. So the rule
 * is said twice: once behind the agent, and once at the end of every turn, by
 * {@link IN_THE_LANGUAGE_OF_THE_WORK}.
 *
 * Measured on a French question put to a swarm of two over two rounds, counting
 * the board posts that came back in French. Standing rule alone: 3 of 18 under
 * the wording that disowned only the prompt, 5 of 19 under the one that disowns
 * the framing too. With the closing line as well: 9 of 35, and 62 of 89. Each
 * half is worth nothing without the other, so neither is a tidy-up.
 *
 * **What must survive translation is named.** A model told to write French
 * writes `PRÊT` for `READY`, `RAS` for `LGTM`, and translates a JSON key that is
 * read by its name. Each of those is a workflow that never ends or a result
 * nobody can parse, and the failure is silent. Rather than list every sentinel
 * here - the library would have to know them all, and a user's own workflow has
 * its own - the rule is stated by shape: a word you were told to answer with
 * comes back exactly as it was given.
 */

/** The standing instruction. Three sentences: the rule, what it points at, and what it never touches. */
export const ANSWER_IN_THEIR_LANGUAGE = [
	"Answer in the language of the work you are given: the request, the specification, the material, the report of another agent.",
	"This prompt and the lines that frame each turn - a round number, what is new, what is left to do - do not decide that language, and neither does any example in them: read it off the work you were handed.",
	"What you were told to answer with is not translated: a word asked for exactly, a JSON key, an agent name, an identifier, a path and anything quoted from code all come back as they were given to you.",
].join(" ");

/**
 * The rule again, in one sentence, at the end of the turn it governs.
 *
 * Short on purpose. The three sentences above belong where they are read once;
 * repeating them every turn would spend a paragraph of context saying what one
 * line says, and the exemptions they carry are already in front of the model.
 *
 * It points *above* itself, which is what puts it last: the work, the framing
 * and this line arrive together, and the one nearest the answer wins.
 *
 * **It says which language, never which one to avoid.** An earlier wording
 * ended "not in the language of these instructions", and a model read the
 * negation as "not English": an English question to a scout came back in
 * French three times in six.
 */
export const IN_THE_LANGUAGE_OF_THE_WORK =
	"Write in the language the work above is written in, whatever language the lines that frame it use.";

/**
 * A turn, plus the line that closes it.
 *
 * Applied by `ask()` and nowhere else, so that a combinator cannot forget it
 * and a workflow somebody else writes gets it for free. What the event stream
 * reports stays the caller's own task: this line is the library's, like the
 * system prompt it echoes, and a card drawing it back would be showing a reader
 * something they did not write.
 */
export function inTheLanguageOfTheWork(task: string): string {
	return `${task}\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`;
}

/**
 * The agent's prompt, plus the language rule.
 *
 * Kept apart from the prompt files so that it reaches a user's agents too, and
 * apart from {@link situate} because they answer different questions: one says
 * where the agent stands, this one says who it is talking to.
 */
export function answerInTheirLanguage(systemPrompt: string): string {
	return `${systemPrompt}\n\n${ANSWER_IN_THEIR_LANGUAGE}`;
}

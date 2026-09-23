/**
 * The agents a flow names, resolved against its catalogue before any spawn.
 *
 * A name is an agent of the catalogue, or a fault: a broken file under that
 * name is reported with its path and cause, and anything else as unknown. An
 * agent found is also held to what spawn would refuse about its skills, so a
 * checked flow never throws there.
 */

import type { Agent, BrokenAgent } from "../agent.ts";
import { toolsOf } from "../session.ts";
import { findSkills, type Skill, type SkillProblem } from "../skills.ts";
import type { FlowCatalogue } from "./catalogue.ts";
import type { FaultList } from "./fault.ts";

/** What an agent's `skills:` resolved to, and every reason one would never reach the model. */
type Found = { readonly skills: readonly Skill[]; readonly problems: readonly SkillProblem[] };

/** The agents of one catalogue, by name. Shared by a checker and its quiet copy. */
export class AgentNames {
	private readonly agents: ReadonlyMap<string, Agent>;
	private readonly broken: ReadonlyMap<string, BrokenAgent>;
	private readonly cwd: string;
	/** An agent's skills and their problems, looked up once however many nodes name it. */
	private readonly found = new Map<Agent, Found>();

	constructor(catalogue: FlowCatalogue) {
		this.agents = new Map(catalogue.agents.map((agent) => [agent.name, agent]));
		this.broken = new Map(catalogue.brokenAgents.map((file) => [file.name, file]));
		this.cwd = catalogue.cwd;
	}

	/** The agent `name` names, written at `at`, or `undefined` after saying why. */
	resolve(name: string, at: string, faults: FaultList): Agent | undefined {
		const agent = this.agents.get(name);
		if (agent === undefined) {
			const broken = this.broken.get(name);
			if (broken !== undefined) faults.add("broken-agent", at, `\`${name}\` is ${broken.filePath}, which is not an agent: ${broken.error}`);
			else faults.unknown("unknown-agent", at, name, [...this.agents.keys()], "agents");
			return undefined;
		}
		const { problems } = this.lookUp(agent);
		for (const problem of problems) faults.add(problem.code, at, problem.message);
		return problems.length === 0 ? agent : undefined;
	}

	/** The skills `agent`'s `skills:` resolved to, as its check found them. */
	skills(agent: Agent): readonly Skill[] {
		return this.lookUp(agent).skills;
	}

	private lookUp(agent: Agent): Found {
		let found = this.found.get(agent);
		if (found === undefined) {
			found = findSkills(agent, this.cwd, toolsOf(agent));
			this.found.set(agent, found);
		}
		return found;
	}
}

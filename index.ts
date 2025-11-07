#! /usr/bin/env bun

import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command, Option } from "commander";
import { Octokit, RequestError } from "octokit";
import TOML from "smol-toml";
import terminalLink from "terminal-link";
import invariant from "tiny-invariant";
import z from "zod";
import {
	type Label,
	renderGithubFieldOption,
	renderGithubLabel,
	renderTrelloLabel,
} from "./lib/label";
import { BoardExport, MapFormat } from "./lib/schemas";

const program = new Command()
	.version("v0.1.0")
	.description("Import a Trello Project into GitHub Issues and Projects.")
	.option("--github-token <token>", "GitHub Personal Access Token")
	.option(
		"-m, --map <file.toml>",
		"A path to a file that maps users and labels",
	)
	// TODO
	.option(
		"--dry-run",
		"Preview what will be transferred (no changes will be made)",
	)
	.option(
		"--keep-closed",
		"Also transfer cards that have been closed (archived)",
	)
	.option(
		"--keep-closed-lists",
		"Also transfer cards that are in a closed (archived) list",
	)
	.addOption(
		new Option(
			"--trello-export <file.json>",
			`a path to a Trello exported file.\nyou can get this by downloading ${chalk.blue.underline(
				"https://trello.com/b/<board-id>.json",
			)}`,
		).conflicts("trelloUrl"),
	)
	.addOption(
		new Option("--trello-url <url>", "the URL to your Trello board").conflicts(
			"trelloExport",
		),
	);

program.parse();
const opts = program.opts();

p.intro(`${chalk.bold.cyanBright("Trello To GitHub")} v0.1.0`);

function onCancel() {
	p.cancel("Operation cancelled.");
	process.exit(0);
}

function fail(message?: string, exitCode = 1): never {
	p.outro(message);
	process.exit(exitCode);
}

const listConjunction = new Intl.ListFormat("en", {
	style: "long",
	type: "conjunction",
});

const group = await p.group(
	{
		mapIsCreated: async () => {
			if (opts.map && typeof opts.map === "string") {
				return true;
			}

			const confirm = await p.confirm({
				message: `Have you created a ${chalk.green("map.toml")} file?`,
			});
			if (!confirm) {
				// TODO: add `create-map` subcommand to help building a `map.toml` file
				p.cancel("Run $0 create-map to build this file.");
				process.exit(0);
			}
		},
		ghToken: async () => {
			if (opts.githubToken && typeof opts.githubToken === "string") {
				return opts.githubToken;
			}
			if (typeof Bun.env.PAT === "string" && Bun.env.PAT.length > 1) {
				return Bun.env.PAT;
			}

			return p.password({
				message: `Provide a ${chalk.underline.blue(terminalLink("Personal Access Token", "https://github.com/settings/tokens"))} with at least the \`${chalk.green("repo")}\` scope.\n${chalk.dim("Issues will be owned by the user this token belongs to.")}`,
				validate: (val) => {
					if (!val) {
						return "Please enter a token.";
					}
				},
			});
		},
		mapFile: async () => {
			if (opts.map && typeof opts.map === "string" && existsSync(opts.map)) {
				return opts.map;
			}

			return p.text({
				message: `Where is your ${chalk.green("map.toml")} file?`,
				placeholder: "./map.toml",
				validate: (val) => {
					if (!val) {
						return "Please enter a path.";
					} else if (!val.endsWith(".toml")) {
						return `The ${chalk.green("map.toml")} file (${chalk.red(val)}) must be a TOML file.`;
					} else if (!existsSync(val)) {
						return `The path ${chalk.red(val)} does not exist.`;
					}
				},
			});
		},
		trelloImportType: async () => {
			if (opts.trelloExport) {
				return "file";
			} else if (opts.trelloUrl) {
				return "url";
			}

			return p.select({
				message: "How would you like to provide your Trello board?",
				options: [
					{
						label: "via URL",
						value: "url",
						hint: "https://trello.com/b/[board-id]",
					},
					{
						label: "via downloaded file",
						value: "file",
						hint: "./export.json",
					},
				],
			});
		},
		trelloImportPath: async ({ results: { trelloImportType } }) => {
			if (opts.trelloExport || opts.trelloUrl) {
				return (opts.trelloExport || opts.trelloUrl) as string;
			}

			if (trelloImportType === "url") {
				return p.text({
					message: "Please enter the URL of your Trello board.",
					placeholder: "https://trello.com/b/[board-id]",
					validate: (val) => {
						const url = URL.parse(val);
						if (!val) {
							return "Please enter a URL.";
						} else if (!url) {
							return "Please enter a valid URL.";
						} else if (url.hostname !== "trello.com") {
							return "Please enter a Trello link.";
						} else if (!/\/b\/\d+/.test(url.pathname)) {
							return "Please enter a Trello board link.";
						}
					},
				});
			} else {
				return p.text({
					message: "Please enter the path to your Trello export file.",
					placeholder: "./export.json",
					validate: (val) => {
						if (!val) {
							return "Please enter a path.";
						} else if (!val.endsWith(".json")) {
							return `The ${chalk.green("export.json")} file (${chalk.red(val)}) must be a JSON file.`;
						} else if (!existsSync(val)) {
							return `The path ${chalk.red(val)} does not exist.`;
						}
					},
				});
			}
		},
	},
	{ onCancel },
);

async function getTrelloData(): Promise<{
	result: ReturnType<typeof BoardExport.safeParse>;
	source: string;
}> {
	let sourceType: "url" | "file";
	let source: string;

	if (opts.trelloUrl) {
		sourceType = "url";
		source = opts.trelloUrl;
	} else if (opts.trelloExport) {
		sourceType = "file";
		source = opts.trelloExport;
	} else {
		sourceType = group.trelloImportType;
		source = group.trelloImportPath as string;
	}

	let trelloVal: unknown;
	if (sourceType === "url") {
		const resp = await fetch(source);
		if (!resp.ok) {
			p.note(
				await resp.body?.text(),
				`HTTP error fetching Trello source [${chalk.red(resp.status)}]`,
			);
			p.cancel(
				`Failed to fetch trello source from ${chalk.underline.cyan(source)}.`,
			);
			process.exit(1);
		}
		trelloVal = await resp.json();
	} else {
		trelloVal = await Bun.file(source).json();
	}

	return { result: BoardExport.safeParse(trelloVal), source };
}

async function getMapData(): Promise<{
	result: ReturnType<typeof MapFormat.safeParse>;
	source: string;
}> {
	const source = group.mapFile;
	const mapVal: unknown = TOML.parse(await Bun.file(source).text());

	return { result: MapFormat.safeParse(mapVal), source };
}

const getTrello = await getTrelloData();
const getMap = await getMapData();

if (!getTrello.result.success) {
	p.log.warn(`Failed to parse export file (${getTrello.source}):`);
	p.log.error(z.prettifyError(getTrello.result.error));
}
if (!getMap.result.success) {
	p.log.warn(`Failed to parse map file (${getMap.source}):`);
	p.log.error(z.prettifyError(getMap.result.error));
}

if (!getTrello.result.success || !getMap.result.success) {
	fail();
}

const trello = getTrello.result.data;
const map = getMap.result.data;

if (!opts.keepClosed) {
	trello.cards = trello.cards.filter((card) => !card.closed);
}

const closedLists = trello.lists
	.filter((list) => list.closed)
	.map((list) => list.id);

if (!opts.keepClosedLists) {
	trello.cards = trello.cards.filter(
		(card) => !closedLists.includes(card.idList),
	);
}

const octokit = new Octokit({ auth: group.ghToken });

const repoData = {
	owner:
		typeof map.repo.owner === "string" ? map.repo.owner : map.repo.owner.login,
	repo: map.repo.repo,
};
const defaultHeaders = { "X-GitHub-Api-Version": "2022-11-28" };
const baseRequest = { ...repoData, headers: defaultHeaders };

const githubLabels = await octokit.request("GET /repos/{owner}/{repo}/labels", {
	...baseRequest,
});
const githubMilestones = await octokit.request(
	"GET /repos/{owner}/{repo}/milestones",
	{
		...baseRequest,
	},
);

const users = [];
for (const user of map.users) {
	try {
		const githubUser = await octokit.request("GET /users/{username}", {
			username: user.github,
			headers: defaultHeaders,
		});
		users.push({ trelloName: user.trello, github: githubUser });
	} catch (e) {
		if (e instanceof RequestError && e.status === 404) {
			// this member doesn't exist
			users.push({
				trelloName: user.trello,
				githubName: user.github,
				github: null,
			});
		} else {
			throw e;
		}
	}
}

async function getProjectInfo() {
	if (!map.project) {
		return null;
	}
	const queryTarget =
		typeof map.repo.owner === "object" && map.repo.owner.type === "organization"
			? "organization"
			: "user";
	const queryLogin =
		typeof map.repo.owner === "object" ? map.repo.owner.login : map.repo.owner;
	const response = await octokit.graphql(`
		query {
			${queryTarget}(login: "${queryLogin}") {
				projectV2(number: ${map.project}) {
					id
					title
					fields(first: 100) {
						nodes {
							... on ProjectV2FieldCommon {
								id
								name
							}
							... on ProjectV2SingleSelectField {
								options {
									id
									name
									color
								}
							}
						}
					}
				}  
			}
		}
  `);

	// Color is one of: BLUE, GRAY, GREEN, ORANGE, PINK, PURPLE, RED, YELLOW

	// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed, but accessing results mirrors the query.
	const res = response as any;

	const statusField: StatusFieldInfo = res[
		queryTarget
	].projectV2.fields.nodes.find(
		(field: Pick<StatusFieldInfo, "name">) => field.name === "Status",
	);

	invariant(
		statusField,
		"every Project should have a Status field (probably? If this is violated, please file an issue.)",
	);

	return {
		projectId: res[queryTarget].projectV2.id,
		projectName: res[queryTarget].projectV2.title,
		statusFieldId: statusField.id,
		statusFieldOptions: statusField.options,
	};
}

const projectInfo = await getProjectInfo();

const labels: Label[] = [];

const invalidLists = [];

// map of Trello List ID to milestone info
type MilestoneInfo = { id: number; number: number; title: string };
const validMilestones: Map<string, MilestoneInfo> = new Map();
const missingMilestones = [];

type StatusFieldInfo = {
	name: string;
	id: string;
	options: { id: string; name: string; color: string }[];
};
let usedStatusWithoutProject = false;
// map of Trello List ID to status field info
const validStatusFields: Map<string, StatusFieldInfo["options"][number]> =
	new Map();
const missingStatusFields = [];
const statusFieldsToCreate: Array<{ trelloListId: string; name: string }> = [];

for (const trelloLabel of trello.labels) {
	const mapped = map.labels.find(
		(labelMap) => labelMap.trello === trelloLabel.name,
	);
	if (!mapped) {
		labels.push({ type: "skipped", trello: trelloLabel });
		continue;
	}
	if (mapped.create) {
		labels.push({
			type: "toCreate",
			trello: trelloLabel,
			github: { name: mapped.github, color: mapped.color },
		});
		continue;
	}
	// the GitHub label where either the ID or the name matches the GitHub mapping
	const githubLabel = githubLabels.data.find(
		(ghLabel) =>
			(Number.isInteger(mapped.github) && ghLabel.id === mapped.github) ||
			ghLabel.name === mapped.github,
	);
	if (!githubLabel) {
		labels.push({
			type: "missing",
			trello: trelloLabel,
			githubLookup: mapped.github,
		});
		continue;
	}
	labels.push({ type: "mapped", trello: trelloLabel, github: githubLabel });
}

for (const mapping of map.lists) {
	const trelloList = trello.lists.find(
		(list) => list.id === mapping.list || list.name === mapping.list,
	);
	if (!trelloList) {
		invalidLists.push(mapping.list);
		continue;
	}

	if (mapping.label) {
		const githubLabel = githubLabels.data.find(
			(ghLabel) =>
				(Number.isInteger(mapping.label) && ghLabel.id === mapping.label) ||
				ghLabel.name === mapping.label,
		);
		if (!githubLabel) {
			labels.push({
				type: "missingList",
				githubLookup: mapping.label,
				trelloList,
			});
			continue;
		}
		labels.push({ type: "listMapped", github: githubLabel, trelloList });
	}

	if (mapping.milestone) {
		const githubMilestone = githubMilestones.data.find(
			(milestone) =>
				(Number.isInteger(mapping.milestone) &&
					(milestone.id === mapping.milestone ||
						milestone.number === mapping.milestone)) ||
				milestone.title === mapping.milestone,
		);
		if (!githubMilestone) {
			missingMilestones.push(mapping.milestone);
			continue;
		}
		validMilestones.set(trelloList.id, githubMilestone);
	}

	if (projectInfo && mapping.status) {
		if (!projectInfo) {
			usedStatusWithoutProject = true;
			continue;
		}
		const projectStatusField = projectInfo.statusFieldOptions.find(
			(field) => field.id === mapping.status || field.name === mapping.status,
		);
		if (!projectStatusField) {
			if (mapping.create && typeof mapping.status === "string") {
				// Status doesn't exist but create flag is set - warn user to create it manually
				statusFieldsToCreate.push({
					trelloListId: trelloList.id,
					name: mapping.status,
				});
			} else {
				// Status doesn't exist and no create flag - error
				missingStatusFields.push(mapping.status);
			}
			continue;
		}
		// Status field exists - map it regardless of create flag
		validStatusFields.set(trelloList.id, projectStatusField);
	}
}

const skippedLists: { id: string; name: string }[] = [];

for (const listKey of map.skip.lists) {
	const trelloList = trello.lists.find(
		(list) => list.id === listKey || list.name === listKey,
	);

	if (trelloList) {
		skippedLists.push(trelloList);
	} else {
		invalidLists.push(listKey);
	}
}

trello.cards = trello.cards.filter(
	(card) => !skippedLists.some((list) => list.id === card.idList),
);

const mappedLabels = labels.filter(
	(l) =>
		l.type === "toCreate" || l.type === "mapped" || l.type === "listMapped",
);
const missingLabels = labels.filter(
	(l) => l.type === "missing" || l.type === "missingList",
);
const skippedLabels = labels.filter((l) => l.type === "skipped");

p.note(
	chalk.reset(
		mappedLabels
			.map((label) => {
				const origin =
					label.type === "listMapped"
						? `From list ${chalk.underline.bold(label.trelloList.name)}`
						: renderTrelloLabel(label);
				return `${origin} -> ${renderGithubLabel(label)}`;
			})
			.join("\n"),
	),
	"Mapping labels:",
);

if (validStatusFields.size > 0) {
	p.note(
		chalk.reset(
			[...validStatusFields.entries()]
				.map(([listId, field]) => {
					return `${chalk.bold(trello.lists.find((list) => list.id === listId)?.name)} -> ${renderGithubFieldOption(field)}`;
				})
				.join("\n"),
		),
		"Mapping columns:",
	);
}

if (skippedLabels.length > 0) {
	const ignoredLabels = listConjunction.format(
		skippedLabels.map((label) => renderTrelloLabel(label)),
	);
	p.log.warn(`These labels will not be transferred: ${ignoredLabels}`);
}

if (missingLabels.length > 0) {
	const unknownLabels = listConjunction.format(
		missingLabels.map((label) =>
			label.type === "missing"
				? `${renderTrelloLabel(label)} (${chalk.dim(label.githubLookup)})`
				: `(From list ${chalk.underline.bold(label.trelloList.name)}) - ${chalk.dim(label.githubLookup)}`,
		),
	);
	p.log.error(`Could not find labels in GitHub: ${unknownLabels}`);
}

if (invalidLists.length > 0) {
	const unknownLists = listConjunction.format(invalidLists);
	p.log.error(
		`These lists (see ${chalk.dim("map.lists[].list")} or ${chalk.dim("map.skip.lists[]")}) do not exist in Trello: ${unknownLists}`,
	);
}

if (missingMilestones.length > 0) {
	const unknownMilestones = listConjunction.format(
		missingMilestones.map((i) => i.toString()),
	);
	p.log.error(
		`These milestones (see ${chalk.dim("map.lists[].milestone")}) do not exist in GitHub: ${unknownMilestones}`,
	);
}

if (missingStatusFields.length > 0) {
	const unknownStatusFields = listConjunction.format(
		missingStatusFields.map((i) => i.toString()),
	);
	p.log.error(
		`These status fields (see ${chalk.dim("map.lists[].status")}) do not exist in the project (${chalk.bold(projectInfo?.projectName)}): ${unknownStatusFields}`,
	);
}

if (statusFieldsToCreate.length > 0) {
	const statusesToCreate = listConjunction.format(
		statusFieldsToCreate.map((s) => chalk.yellow(s.name)),
	);
	p.log.warn(
		`These status fields need to be created manually (${chalk.dim("create = true")}): ${statusesToCreate}`,
	);
	p.log.info(
		`${chalk.dim("→")} Please create them in your GitHub Project settings at:\n  ${chalk.blue.underline(`https://github.com/${typeof map.repo.owner === "string" ? `users/${map.repo.owner}` : `orgs/${map.repo.owner.login}`}/projects/${projectInfo?.projectId?.split("_").pop()}/settings`)}`,
	);
	p.log.info(
		`${chalk.dim("→")} After creating them, re-run this tool.`,
	);
}

if (usedStatusWithoutProject) {
	p.log.error(
		`The ${chalk.dim("`map.lists[].status`")} option can only be used if ${chalk.dim("`map.project`")} is set.`,
	);
}

const validMembers = users.filter((mem) => mem.github);
const invalidMembers = users.filter((mem) => !mem.github);

if (invalidMembers.length > 0) {
	const missingUsers = listConjunction.format(
		invalidMembers.map(
			(member) =>
				`${chalk.bold(`@${member.trelloName}`)} (${chalk.dim(`@${member.githubName}`)})`,
		),
	);
	p.log.error(
		`The following Trello users are not GitHub Users: ${missingUsers}`,
	);
}

if (
	missingLabels.length > 0 ||
	invalidMembers.length > 0 ||
	invalidLists.length > 0 ||
	missingMilestones.length > 0 ||
	missingStatusFields.length > 0 ||
	statusFieldsToCreate.length > 0 ||
	usedStatusWithoutProject
) {
	fail();
}

if (skippedLabels.length > 0) {
	const conf = await p.confirm({ message: "Would you like to continue?" });
	if (p.isCancel(conf) || !conf) {
		onCancel();
	}
}

const labelsToCreate = labels.filter((l) => l.type === "toCreate");
const existingLabelsToCreate = labelsToCreate.filter((label) =>
	githubLabels.data.some((ghLabel) => ghLabel.name === label.github.name),
);

if (existingLabelsToCreate.length > 0) {
	const existingLabels = listConjunction.format(
		existingLabelsToCreate.map((label) => renderGithubLabel(label)),
	);
	p.log.warn(`These labels already exist in GitHub: ${existingLabels}`);
	const conf = await p.confirm({
		message: "Are you sure you would like to continue creating them?",
	});
	if (p.isCancel(conf) || !conf) {
		onCancel();
	}
}

if (labelsToCreate.length > 0) {
	const spin = p.spinner({ indicator: "timer" });
	spin.start(`Creating labels [0/${labelsToCreate.length}]`);
	let createdCount = 0;
	let skippedCount = 0;
	for (const [count, label] of labelsToCreate.entries()) {
		try {
			await octokit.request("POST /repos/{owner}/{repo}/labels", {
				...baseRequest,
				name: label.github.name,
				color: label.github.color?.trim().replace(/^#/, ""),
			});
			createdCount++;
		} catch (e) {
			if (e instanceof RequestError && e.status === 422) {
				// Label already exists, skip it
				p.log.warn(`Label ${chalk.yellow(label.github.name)} already exists, skipping...`);
				skippedCount++;
			} else {
				// Re-throw other errors
				throw e;
			}
		}
		spin.message(`Creating labels [${count + 1}/${labelsToCreate.length}]`);
	}
	spin.stop(`Created ${createdCount} labels${skippedCount > 0 ? `, skipped ${skippedCount} existing labels` : ""}.`);
}

function mapMemberId(trelloMemberId: string): string | null {
	const trelloMember = trello.members.find((mem) => mem.id === trelloMemberId);
	if (!trelloMember) return null;

	// Trello members can be searched by ID, username, or full name
	const member = validMembers.find((mem) =>
		[trelloMember.id, trelloMember.username, trelloMember.fullName].includes(
			mem.trelloName,
		),
	);
	if (!member?.github) return null;
	return member.github.data.login;
}

function mapMemberIds(trelloMemberIds: string[]): string[] {
	return trelloMemberIds.map(mapMemberId).filter((m) => m !== null);
}

type TrelloCard = (typeof trello.cards)[number];

function getDescriptionForCard(card: TrelloCard): string {
	let body = "";
	if (card.desc.length > 0) {
		body += card.desc;
	}

	const checklistStr = getChecklistContentForCard(card);
	if (checklistStr) {
		if (card.desc.length > 0) {
			body += "\n\n---\n\n";
		}
		body += checklistStr;
	}

	if (card.desc.length > 0 || checklistStr) {
		body += "\n\n---\n\n";
	}
	body += `> Migrated from [Trello Card](${card.url})\n`;
	body += card.attachments
		.map((attachment) => `- [${attachment.name}](${attachment.url})`)
		.join("\n");

	return body;
}

function getLabelsForCard(card: TrelloCard): string[] {
	const res = [];
	for (const trelloName of card.labels.map((label) => label.name)) {
		const found = mappedLabels.find(
			(label) =>
				label.type !== "listMapped" && label.trello.name === trelloName,
		);
		if (found) {
			res.push(found.github.name);
		}
	}

	const listLabel = mappedLabels.find(
		(label) =>
			label.type === "listMapped" && label.trelloList.id === card.idList,
	);
	if (listLabel) {
		res.push(listLabel.github.name);
	}

	return res;
}

function getChecklistContentForCard(card: TrelloCard): string | null {
	const res = [];
	const checklists = card.idChecklists
		.map((id) => trello.checklists.find((checklist) => checklist.id === id))
		.filter((check) => check !== undefined);

	if (checklists.length < 1) {
		return null;
	}

	res.push("\n## Checklists");
	for (const checklist of checklists) {
		res.push(`### ${checklist.name}`);
		for (const item of checklist.checkItems) {
			if (item.state === "complete") {
				res.push(`- [x] ${item.name}`);
			} else {
				res.push(`- [ ] ${item.name}`);
			}
		}
	}

	return res.join("\n");
}

function getCommentsForCard(card: TrelloCard): string[] {
	const res = [];
	const commentActions = trello.actions.filter(
		(action) => action.type === "commentCard" && action.data.idCard === card.id,
	);
	commentActions.sort((a, b) => a.date.getTime() - b.date.getTime());

	for (const action of commentActions) {
		const member = mapMemberId(action.memberCreator.id);
		const memberString = member
			? `@${member}`
			: `\`@${action.memberCreator.username}\``;

		const header = `## ${memberString} • ${action.date.toLocaleDateString()}`;
		res.push(`${header}\n${action.data.text}`);
	}

	return res;
}

async function addIssueToProject(issueNodeId: string) {
	invariant(
		projectInfo,
		"projectInfo must be set to call `addIssueToProject()`.",
	);
	const res = await octokit.graphql(`
	mutation {
		addProjectV2ItemById(input: {projectId: "${projectInfo.projectId}" contentId: "${issueNodeId}"}) {
			item {
				id
			}
		}
	}`);

	// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed, but accessing results mirrors the query.
	return (res as any).addProjectV2ItemById.item.id;
}

async function setIssueStatus(itemId: string, statusId: string, statusName: string) {
	invariant(projectInfo, "projectInfo must be set to call `setIssueStatus()`.");
	try {
		const result = await octokit.graphql(`
			mutation {
				updateProjectV2ItemFieldValue(
					input: {projectId: "${projectInfo.projectId}", itemId: "${itemId}", fieldId: "${projectInfo.statusFieldId}", value: {singleSelectOptionId: "${statusId}"}}
				) {
					projectV2Item {
						id
						fieldValueByName(name: "Status") {
							... on ProjectV2ItemFieldSingleSelectValue {
								name
							}
						}
					}
				}
			}`);
		// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed
		const updatedStatus = (result as any).updateProjectV2ItemFieldValue.projectV2Item.fieldValueByName?.name;
		if (updatedStatus) {
			p.log.info(`✓ Status set to: ${chalk.green(updatedStatus)}`);
		}
	} catch (error) {
		p.log.error(`Failed to set status to ${chalk.yellow(statusName)}: ${error}`);
		throw error;
	}
}

async function getExistingProjectItems() {
	invariant(projectInfo, "projectInfo must be set to call `getExistingProjectItems()`.");
	
	const queryTarget = map.repo.owner;
	const ownerType = typeof queryTarget === "string" ? "user" : queryTarget.type;
	
	const items: Array<{
		id: string;
		issueNumber: number;
		issueTitle: string;
		currentStatus: string | null;
	}> = [];
	
	let hasNextPage = true;
	let cursor: string | null = null;
	
	while (hasNextPage) {
		const query = `
			query {
				${ownerType}(login: "${typeof queryTarget === "string" ? queryTarget : queryTarget.login}") {
					projectV2(number: ${map.project}) {
						items(first: 100${cursor ? `, after: "${cursor}"` : ""}) {
							pageInfo {
								hasNextPage
								endCursor
							}
							nodes {
								id
								content {
									... on Issue {
										number
										title
									}
								}
								fieldValueByName(name: "Status") {
									... on ProjectV2ItemFieldSingleSelectValue {
										name
									}
								}
							}
						}
					}
				}
			}
		`;
		
		// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed
		const response: any = await octokit.graphql(query);
		const itemsData = response[ownerType].projectV2.items;
		
		for (const item of itemsData.nodes) {
			if (item.content && item.content.number) {
				items.push({
					id: item.id,
					issueNumber: item.content.number,
					issueTitle: item.content.title,
					currentStatus: item.fieldValueByName?.name || null,
				});
			}
		}
		
		hasNextPage = itemsData.pageInfo.hasNextPage;
		cursor = itemsData.pageInfo.endCursor;
	}
	
	return items;
}

// Check and update statuses for existing issues in the project
if (projectInfo && validStatusFields.size > 0) {
	const existingSpin = p.spinner({ indicator: "timer" });
	existingSpin.start("Checking existing project items...");
	
	const existingItems = await getExistingProjectItems();
	existingSpin.stop(`Found ${chalk.blue(existingItems.length)} existing items in project`);
	
	if (existingItems.length > 0) {
		p.log.info("Checking and updating statuses for existing items...");
		
		let updatedCount = 0;
		let skippedCount = 0;
		
		for (const item of existingItems) {
			// Try to find the corresponding Trello card by matching title
			const trelloCard = trello.cards.find((card) => {
				// Simple match by title - you might want to make this more sophisticated
				return card.name === item.issueTitle;
			});
			
			if (!trelloCard) {
				// Issue doesn't match any Trello card, skip it
				skippedCount++;
				continue;
			}
			
			// Get the expected status for this card based on its Trello list
			const expectedStatus = validStatusFields.get(trelloCard.idList);
			
			if (!expectedStatus) {
				// No status mapping for this list
				skippedCount++;
				continue;
			}
			
			// Check if the current status matches the expected status
			if (item.currentStatus !== expectedStatus.name) {
				p.log.info(
					`Updating issue #${chalk.blue(item.issueNumber)} "${chalk.dim(item.issueTitle.slice(0, 50))}..." from ${chalk.yellow(item.currentStatus || "no status")} to ${chalk.green(expectedStatus.name)}`,
				);
				await setIssueStatus(item.id, expectedStatus.id, expectedStatus.name);
				updatedCount++;
			} else {
				skippedCount++;
			}
		}
		
		p.log.info(
			`Updated ${chalk.green(updatedCount)} existing items, skipped ${chalk.dim(skippedCount)} items`,
		);
	}
}

const spin = p.spinner({ indicator: "timer" });
spin.start(`Creating ${chalk.blue(trello.cards.length)} issues`);

// Debug: Show the validStatusFields mapping
if (projectInfo && validStatusFields.size > 0) {
	p.log.info("Status field mappings:");
	for (const [listId, statusOption] of validStatusFields.entries()) {
		const list = trello.lists.find((l) => l.id === listId);
		p.log.info(
			`  ${chalk.cyan(list?.name || listId)} -> ${chalk.green(statusOption.name)}`,
		);
	}
}

for (const [i, card] of trello.cards.entries()) {
	const issue = await octokit.request("POST /repos/{owner}/{repo}/issues", {
		...baseRequest,
		title: card.name,
		body: getDescriptionForCard(card),
		labels: getLabelsForCard(card),
		assignees: mapMemberIds(card.idMembers),
		milestone: validMilestones.get(card.id)?.number,
	});

	const comments = getCommentsForCard(card);
	for (const comment of comments) {
		await octokit.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				...baseRequest,
				issue_number: issue.data.number,
				body: comment,
			},
		);
	}

	if (projectInfo) {
		const itemId = await addIssueToProject(issue.data.node_id);
		const cardList = trello.lists.find((list) => list.id === card.idList);
		const status = validStatusFields.get(card.idList);
		
		if (status) {
			p.log.info(
				`Setting "${chalk.blue(card.name)}" (from list "${chalk.cyan(cardList?.name)}") to status ${chalk.green(status.name)}`,
			);
			await setIssueStatus(itemId, status.id, status.name);
		} else {
			// Debug: log when status mapping is not found
			p.log.warn(
				`No status mapping found for card "${chalk.yellow(card.name)}" in list "${chalk.yellow(cardList?.name || card.idList)}"`,
			);
		}
	}

	spin.message(
		`Creating ${chalk.blue(trello.cards.length)} issues • issue ${chalk.blue(i + 1)}/${chalk.blue(trello.cards.length)}`,
	);
}

spin.stop(`Created ${chalk.blue(trello.cards.length)} issues`);
p.outro();

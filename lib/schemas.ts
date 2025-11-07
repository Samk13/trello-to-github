import { z } from "zod/v4";

export type Trello = z.infer<typeof BoardExport>;
export const BoardExport = z.object({
	name: z.string(),
	// The lists in the board
	lists: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			closed: z.boolean(),
		}),
	),
	members: z.array(
		z.object({
			id: z.string(),
			fullName: z.string(),
			username: z.string(),
		}),
	),
	actions: z.array(
		z.union([
			// comment on card
			z.object({
				id: z.string(),
				memberCreator: z.object({
					id: z.string(),
					username: z.string(),
				}),
				data: z.object({
					idCard: z.string(),
					text: z.string(),
				}),
				type: z.literal("commentCard"),
				date: z.date(),
			}),
			// other objects are stripped
			z.object({}),
		]),
	),
	// The cards in the board
	cards: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			url: z.string(),
			// called "archived" in Trello's Web UI
			closed: z.boolean(),
			desc: z.string(),
			// The IDs of the checklists it displays
			idChecklists: z.array(z.string()),
			// The ID of the list it belongs to (see `lists`)
			idList: z.string(),
			// The IDs of members assigned to it
			idMembers: z.array(z.string()),
			labels: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					color: z.string(),
					uses: z.int(),
				}),
			),
			attachments: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					url: z.string(),
				}),
			),
		}),
	),
	// The labels in the board
	labels: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			color: z.string(),
			uses: z.int(),
		}),
	),
	// Checklists, which are rendered next to the description of a card (`idCard`).
	checklists: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			idCard: z.string(),
			checkItems: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					state: z.enum(["complete", "incomplete"]),
				}),
			),
		}),
	),
});

export type Map = z.infer<typeof MapFormat>;
export const MapFormat = z.object({
	// The repository to transfer into
	repo: z.object({
		owner: z.union([
			z.object({
				type: z.enum(["organization", "user"]),
				login: z.string().min(1),
			}),
			z.string().min(1),
		]),
		repo: z.string().min(1),
	}),
	// (optional) The ID of the project to add created issues to
	project: z.int().optional(),
	labels: z.array(
		z.discriminatedUnion("create", [
			// fetch label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// If a string, assumed to be the name of a label. If an int, it's the ID of the label.
				github: z.union([z.string().min(1), z.int()]),
				// Whether to create the label, if it does not exist.
				create: z.literal(false).optional().default(false),
			}),
			// create new label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// The name of the label to create.
				github: z.string().min(1),
				// Whether to create the label, if it does not exist.
				create: z.literal(true),
				// The color to create the GitHub label with.
				color: z
					.string()
					.regex(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i)
					.optional(),
			}),
		]),
	),
	// maps assignees
	users: z
		.array(
			z.object({
				// The name of the user in Trello.
				trello: z
					.string()
					.min(1)
					.refine((arg) => arg.replace(/^@/, "")),
				// The username of the user in GitHub.
				github: z
					.string()
					.min(1)
					.refine((arg) => arg.replace(/^@/, "")),
			}),
		)
		.optional()
		.default([]),
	// maps the Trello List of each card to:
	// 	 a) a GitHub Projects Status (`status =`)
	// 	 b) a GitHub Label (`label =`)
	// 	 c) a GitHub Milestone (`milestone =`)
	lists: z
		.array(
			z.object({
				list: z.string().min(1),
				// `lists[].status` is only valid if `.project` is set
				status: z.union([z.int(), z.string().min(1)]).optional(),
				// Whether to create the status field option if it doesn't exist (only works with status)
				create: z.boolean().optional().default(false),
				// the other two are applicable anywhere
				label: z.union([z.int(), z.string().min(1)]).optional(),
				milestone: z.union([z.int(), z.string().min(1)]).optional(),
			}),
		)
		.optional()
		.default([]),
	skip: z
		.object({
			// Do not migrate a card if it is in any of these lists
			lists: z.array(z.string().min(1)).optional().default([]),
		})
		.optional()
		.default({ lists: [] }),
});

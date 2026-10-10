// The setup sections, in SECTIONS order (spec §3.1).
import type { Step } from "../context.ts";
import { step as github } from "./github.ts";
import { step as models } from "./models.ts";
import { step as prereqs } from "./prereqs.ts";
import { step as qa } from "./qa.ts";
import { step as roles } from "./roles.ts";
import { step as search } from "./search.ts";
import { step as service } from "./service.ts";

export const STEPS: Step[] = [prereqs, github, models, roles, qa, search, service];

import type { AgentTemplate } from "../templates.shape";

import { AUTOMOTIVE } from "./automotive";
import { COMMUNITY } from "./community";
import { EDUCATION } from "./education";
import { FINANCE } from "./finance";
import { GENERAL } from "./general";
import { HEALTHCARE } from "./healthcare";
import { HOME_SERVICES } from "./home-services";
import { HOSPITALITY } from "./hospitality";
import { LOGISTICS } from "./logistics";
import { OUTBOUND } from "./outbound";
import { PROFESSIONAL } from "./professional";
import { PROPERTY } from "./property";
import { RETAIL } from "./retail";
import { TELECOMS } from "./telecoms";
import { TRAVEL } from "./travel";
import { UTILITIES } from "./utilities";

/**
 * The catalogue: one complete front desk per kind of Nigerian organisation.
 *
 * "Complete" is the standard each one is held to. Somebody who picks a template should be
 * able to publish it with a name and nothing else and have an agent that handles what a
 * business of that kind is rung about, day to day — every service as its own conversation,
 * forking where the real call forks, confirming what must be confirmed, handing over where a
 * machine must not decide, and knowing what it must never do. A template that needs its
 * questions rewritten before it works is a blank page with extra steps.
 *
 * Every prompt is speech, for a Nigerian caller: naira, WAT, landmarks for addresses, "ma"
 * and "sir" understood, Pidgin understood. Identifiers are read back; phone numbers are
 * taken by keypad or speech and read back grouped; free text is taken in the caller's own
 * words and summarised. Anything a business must never do on the phone — quote a refund,
 * diagnose, promise a delivery time, discuss somebody else's account — is a policy, because
 * the model will be asked to do it.
 *
 * One file per sector, in the order the gallery lists them.
 */
export const CATALOGUE_TEMPLATES: readonly AgentTemplate[] = [...GENERAL, ...PROPERTY, ...HOSPITALITY, ...HEALTHCARE, ...FINANCE, ...TELECOMS, ...UTILITIES, ...LOGISTICS, ...RETAIL, ...TRAVEL, ...EDUCATION, ...COMMUNITY, ...PROFESSIONAL, ...HOME_SERVICES, ...AUTOMOTIVE, ...OUTBOUND];

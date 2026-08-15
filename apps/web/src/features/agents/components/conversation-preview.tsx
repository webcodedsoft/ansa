import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import type { CapturedField } from "../agents.schema";
import { heardAs, readBackOf, spokenValue } from "../capture-vocabulary";

/**
 * What a template sounds like, end to end.
 *
 * A template is a list of dropdown values, and nobody can judge one by reading it. What
 * they can judge is the call it produces — which is why the whole exchange is generated
 * here rather than described. Somebody comparing "Customer service" against "After hours"
 * is comparing two conversations, which is the actual decision.
 *
 * The same idea as the pane in `field-builder.tsx`, at a different scale: that one previews
 * a single field while you edit it, this one previews every field in order plus the
 * greeting. The two share their sample values and their read-back wording by copy rather
 * than by import, which is worth fixing when either changes — see the note in the report.
 */

const Line = ({ who, text }: { readonly who: "agent" | "caller"; readonly text: string }) => (
  <div>
    <p className="mb-1 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
      {who}
    </p>
    <p
      className={cn(
        "rounded-[10px] border px-3 py-2 text-[12.5px]",
        who === "agent"
          ? "border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink)]"
          : "border-[color-mix(in_srgb,var(--accent)_26%,transparent)] bg-[var(--accent-soft)] text-[var(--ink)]",
      )}
    >
      {text}
    </p>
  </div>
);

export const ConversationPreview = ({
  greeting,
  fields,
}: {
  readonly greeting: string;
  readonly fields: readonly CapturedField[];
}) => {
  const confirmed = fields.filter((one) => one.confirm !== "none").length;
  const keyed = fields.filter((one) => one.capture === "keypad").length;

  return (
    <div className="flex flex-col gap-2.5">
      {greeting === "" && fields.length === 0 ? (
        <p className="text-[12.5px] text-[var(--ink-3)]">
          Nothing to preview — this one starts empty, and every word of the call is yours to
          write.
        </p>
      ) : (
        <>
          {greeting !== "" && <Line who="agent" text={greeting} />}
          {greeting !== "" && <Line who="caller" text="Hello — yes, I hope so." />}

          {fields.map((one) => {
            const value = spokenValue(one);
            return (
              <div key={one.key} className="flex flex-col gap-2.5">
                <Line who="agent" text={one.prompt === "" ? `asks for their ${one.key}` : one.prompt} />
                <Line who="caller" text={heardAs(one, value)} />
                {one.confirm !== "none" && (
                  <>
                    <Line who="agent" text={readBackOf(one, value)} />
                    <Line who="caller" text="Yes." />
                  </>
                )}
              </div>
            );
          })}

          {fields.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Tag>
                {fields.length} {fields.length === 1 ? "field" : "fields"}
              </Tag>
              {/* Both are worth seeing at a glance, because both are the difference between
                  a value a tool may act on and a guess it must refuse. */}
              {confirmed > 0 && <Tag tone="ok">{confirmed} confirmed</Tag>}
              {keyed > 0 && <Tag tone="accent">{keyed} keyed in</Tag>}
            </div>
          )}
        </>
      )}
    </div>
  );
};

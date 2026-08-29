import Link from "next/link";

import { Card, EmptyState, Stat, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { when } from "@/lib/format";

import { label, type QuestionDetail } from "../captures";

/**
 * One question, and what people said to it.
 *
 * Reached by clicking a row in the agent's list of questions, so it needs no rail of its own —
 * the list you came from is the navigation, and Back returns to it. That is the whole reason
 * this reads as a page rather than as a pane: you arrive already knowing which question you
 * asked for.
 *
 * The bar is a share of the answers given, not of the calls. Mixing the two produces a chart
 * where nothing adds up and every figure needs a footnote.
 */
export const QuestionView = ({
  detail,
  agentId,
  prompt,
}: {
  readonly detail: QuestionDetail;
  readonly agentId: string;
  /** What the agent actually says. The point of comparison for a question going wrong. */
  readonly prompt: string;
}) => {
  const share = detail.total === 0 ? 0 : detail.retried / detail.total;

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <Link
          href={`/data?agentId=${agentId}`}
          className="text-[13px] text-[var(--ink-3)] hover:text-[var(--ink)] hover:underline"
        >
          ← All questions
        </Link>
        <span className="font-mono text-[11px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
          {detail.type}
        </span>
      </div>

      <h2 className="text-[24px] font-semibold tracking-[-0.028em]">{label(detail.key)}</h2>
      {prompt.trim() !== "" && (
        /* The wording, quoted. A question with a bad retry rate is usually a question that reads
           badly out loud, and reading it is the fastest way to see that. */
        <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--ink-2)] italic">
          “{prompt}”
        </p>
      )}

      <div className="mt-5 grid gap-3.5 sm:grid-cols-3">
        <Stat label="Answers given" value={detail.total} />
        <Stat
          label="Asked more than once"
          value={detail.retried}
          tone={detail.retried === 0 ? "flat" : "down"}
          trend={detail.total === 0 ? undefined : `${Math.round(share * 100)}% of answers`}
        />
        <Stat
          label="Worst case"
          value={detail.worstAttempts === 0 ? "—" : detail.worstAttempts}
          trend={detail.worstAttempts === 0 ? undefined : "attempts on one call"}
        />
      </div>

      <div className="mt-[26px] flex flex-col gap-3.5">
        <Card
          title="What people said"
          description={
            detail.type === "choice"
              ? "Every option this question offers, most chosen first. An option at zero is one nobody has ever taken."
              : "Most given first."
          }
        >
          {detail.answers.length === 0 ? (
            <EmptyState title="Nobody has answered this question">
              It is in the agent&rsquo;s form and no caller has given it a value in this range.
              Either the conversation never reaches it, or the wording is not landing.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {detail.answers.map((answer) => (
                <div key={answer.value} className="flex items-center gap-3">
                  <span className="w-[220px] flex-none truncate text-[13px]">
                    {answer.count === 0 ? (
                      <span className="text-[var(--bad)]">{answer.value}</span>
                    ) : (
                      answer.value
                    )}
                  </span>
                  <span className="h-[9px] flex-1 overflow-hidden rounded-[2px] bg-[var(--surface-2)]">
                    <span
                      className="block h-full bg-[var(--accent)] opacity-75"
                      style={{ width: `${Math.round(answer.share * 100)}%` }}
                    />
                  </span>
                  <span className="w-[64px] flex-none text-right font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">
                    {answer.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {detail.rows.length > 0 && (
          <Card title="Every call that answered it" description="Newest first.">
            <Table>
              <thead>
                <Tr>
                  <Th className="w-[160px]">When</Th>
                  <Th className="w-[160px]">Caller</Th>
                  <Th>Answer</Th>
                  <Th className="w-[110px] text-right">Attempts</Th>
                </Tr>
              </thead>
              <tbody>
                {detail.rows.map((row) => (
                  <Tr key={`${row.callId}-${row.fieldKey}`}>
                    <Td className="whitespace-nowrap text-[var(--ink-3)]">
                      <Link
                        href={`/calls/${row.callId}`}
                        className="hover:text-[var(--ink)] hover:underline"
                      >
                        {when(row.calledAt)}
                      </Link>
                    </Td>
                    <Td className="tabular-nums whitespace-nowrap">{row.caller ?? "Unknown"}</Td>
                    <Td className="break-all">{row.value}</Td>
                    <Td className="text-right">
                      {row.attempts > 1 ? (
                        <Tag tone="warn">{row.attempts}</Tag>
                      ) : (
                        <span className="text-[var(--ink-3)] tabular-nums">1</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </div>
    </>
  );
};

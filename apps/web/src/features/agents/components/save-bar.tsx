import { Row, SubmitButton } from "@/components/ui";

/**
 * The save control, repeated on every tab that has fields.
 *
 * It saves the whole configuration, not this tab's part of it — there is one endpoint and one
 * document, so there is no such thing as saving the voice without the greeting. The label says
 * "changes" rather than naming the tab for exactly that reason: three buttons each claiming to
 * save their own section was the lie the previous ones told, and the sentence beside it is the
 * correction rather than a footnote.
 *
 * They exist per tab anyway because the alternative — one button in the header — makes
 * somebody scroll back up to save what they have just typed. What made the old buttons a
 * defect was never where they sat, it was that they published: each one put every tab on the
 * next call under a label saying Save. This writes a draft, which no call can read.
 */
export const SaveBar = ({
  pending,
  form,
}: {
  readonly pending: boolean;
  /** The workspace's one form, by id, so this works from a panel that does not contain it. */
  readonly form: string;
}) => (
  <Row>
    <SubmitButton
      variant="secondary"
      pending={pending}
      idle="Save changes"
      busy="Saving…"
      form={form}
    />
    <span className="text-[12.5px] text-[var(--ink-3)]">
      Saves everything you have edited, on every tab. Nothing reaches a caller until you publish.
    </span>
  </Row>
);

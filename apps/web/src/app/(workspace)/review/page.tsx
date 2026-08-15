import type { Metadata } from "next";

import { Card, PageHeader } from "@/components/ui";
import { listReviewQueue } from "@/features/calls/calls.service";
import { ReviewQueueTable } from "@/features/calls/components/review-queue-table";

export const metadata: Metadata = { title: "Review queue · Ansa" };
export const dynamic = "force-dynamic";

const ReviewPage = async () => {
  const queue = await listReviewQueue();

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Review queue"
        meta={`Over the last ${queue.scanned} calls, ${queue.flagged} flagged. Severity orders the list and means nothing else — a call at 20 is opened before a call at 8, and two calls at 8 are equally next rather than equally bad.`}
      />
      <Card>
        <ReviewQueueTable calls={queue.calls} />
      </Card>
    </>
  );
};

export default ReviewPage;

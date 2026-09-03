-- CreateTable
CREATE TABLE "DeadLetterEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "queueName" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bodyType" TEXT NOT NULL,
    "workKind" TEXT,
    "workId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "DeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterEvent_messageId_key" ON "DeadLetterEvent"("messageId");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_resolvedAt_receivedAt_idx" ON "DeadLetterEvent"("resolvedAt", "receivedAt");

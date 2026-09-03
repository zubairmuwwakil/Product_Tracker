type QueueBatch = {
  messages: readonly Array<{ body: unknown }>;
};

export default {
  async queue(batch: QueueBatch): Promise<void> {
    console.log("Reliability DLQ received", {
      count: batch.messages.length,
      bodyTypes: batch.messages.map((message) =>
        message.body === null ? "null" : Array.isArray(message.body) ? "array" : typeof message.body,
      ),
    });
  },
};

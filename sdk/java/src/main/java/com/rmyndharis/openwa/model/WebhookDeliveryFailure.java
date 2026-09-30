package com.rmyndharis.openwa.model;

/**
 * A webhook delivery the gateway gave up on or could not dispatch, as listed by the
 * delivery-failure log. Optional fields are {@code null} when absent.
 */
public record WebhookDeliveryFailure(
    String id,
    String webhookId,
    String sessionId,
    String event,
    String url,
    /** The idempotency key the receiver would have deduped on. */
    String idempotencyKey,
    String deliveryId,
    /**
     * Delivery attempts recorded; 0 when the delivery was shed, refused or failed before sending
     * (oversize payload, a payload that could not be serialized after the webhook:before hooks,
     * capacity shed or shutdown). A direct delivery that shutdown caught in a retry backoff also
     * records 0, although its earlier attempts were sent.
     */
    int attempts,
    /**
     * Last HTTP status when the failure was a non-2xx response; {@code null} for a network or
     * timeout error, or when attempts is 0.
     */
    Integer lastStatusCode,
    String lastError,
    /** ISO timestamp of when the failure was recorded. */
    String createdAt) {}

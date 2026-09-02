package com.rmyndharis.openwa.model;

import java.util.Map;

/**
 * A persisted message row, as returned by {@code GET /sessions/:id/messages}.
 * Optional fields are {@code null} when absent.
 */
public record MessageRecord(
    String id,
    String sessionId,
    /** Engine/WhatsApp message id; may be {@code null} until a send is acked. */
    String waMessageId,
    String chatId,
    String from,
    String to,
    String body,
    String type,
    MessageDirection direction,
    /** Chat display name, when the session resolves one for the chat. */
    String chatName,
    /** Author display name for an inbound group message. */
    String author,
    /** Storage key of the archived media copy, when chat-media archiving wrote one. */
    String mediaPath,
    /** Mimetype of the archived media; null whenever mediaPath is. */
    String mediaMimetype,
    /** Unix timestamp in seconds. */
    Long timestamp,
    Map<String, Object> metadata,
    DeliveryStatus status,
    String createdAt) {}

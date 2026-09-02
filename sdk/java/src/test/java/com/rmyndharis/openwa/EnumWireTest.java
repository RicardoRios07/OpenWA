package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.rmyndharis.openwa.model.AccountRestrictionKind;
import com.rmyndharis.openwa.model.BatchLifecycleStatus;
import com.rmyndharis.openwa.model.BatchMessageResult;
import com.rmyndharis.openwa.model.BatchMessageStatus;
import com.rmyndharis.openwa.model.ChatHistoryMessage;
import com.rmyndharis.openwa.model.ChatKind;
import com.rmyndharis.openwa.model.MemberAddMode;
import com.rmyndharis.openwa.model.MessageType;
import com.rmyndharis.openwa.model.PresenceState;
import com.rmyndharis.openwa.model.SessionResponse;
import com.rmyndharis.openwa.model.SessionStatus;
import org.junit.jupiter.api.Test;

/**
 * Wire-format round trips for the enum-backed record components: the API speaks lowercase and
 * snake_case ("qr_ready", "reachout_timelock"), while Java constants are UpperCamel — every enum
 * must carry a {@code @SerializedName} that maps the exact wire token in BOTH directions.
 */
class EnumWireTest {

    private final Gson gson = new GsonBuilder().create();

    @Test
    void sessionStatusRoundTripsEveryWireToken() {
        record Pair(String wire, SessionStatus constant) {}
        Pair[] pairs = {
            new Pair("created", SessionStatus.CREATED),
            new Pair("initializing", SessionStatus.INITIALIZING),
            new Pair("qr_ready", SessionStatus.QR_READY),
            new Pair("authenticating", SessionStatus.AUTHENTICATING),
            new Pair("ready", SessionStatus.READY),
            new Pair("disconnected", SessionStatus.DISCONNECTED),
            new Pair("action_required", SessionStatus.ACTION_REQUIRED),
            new Pair("failed", SessionStatus.FAILED),
        };
        for (Pair pair : pairs) {
            SessionResponse r = gson.fromJson(
                "{\"id\":\"s\",\"name\":\"n\",\"status\":\"" + pair.wire() + "\",\"engineLoaded\":true,"
                    + "\"createdAt\":\"t\",\"updatedAt\":\"t\"}",
                SessionResponse.class);
            assertEquals(pair.constant(), r.status(), pair.wire());
            assertEquals(pair.wire(), gson.toJsonTree(r.status()).getAsString(), pair.wire());
        }
    }

    @Test
    void messageAndChatKindRoundTrip() {
        ChatHistoryMessage m = gson.fromJson(
            "{\"id\":\"m\",\"from\":\"a\",\"to\":\"b\",\"chatId\":\"c\",\"body\":\"x\","
                + "\"type\":\"sticker\",\"timestamp\":1,\"fromMe\":true,\"isGroup\":true,\"kind\":\"broadcast\"}",
            ChatHistoryMessage.class);
        assertEquals(MessageType.STICKER, m.type());
        assertEquals(ChatKind.BROADCAST, m.kind());
        assertEquals("sticker", gson.toJsonTree(m.type()).getAsString());
    }

    @Test
    void batchPresenceRestrictionAndMemberAddModeRoundTrip() {
        BatchMessageResult b = gson.fromJson(
            "{\"chatId\":\"628@c.us\",\"status\":\"cancelled\"}", BatchMessageResult.class);
        assertEquals(BatchMessageStatus.CANCELLED, b.status());

        com.rmyndharis.openwa.model.BatchStatusResponse s = gson.fromJson(
            "{\"batchId\":\"b1\",\"status\":\"processing\",\"progress\":{\"total\":1,\"sent\":0,"
                + "\"failed\":0,\"pending\":1,\"cancelled\":0},\"results\":[]}",
            com.rmyndharis.openwa.model.BatchStatusResponse.class);
        assertEquals(BatchLifecycleStatus.PROCESSING, s.status());

        com.rmyndharis.openwa.model.ParticipantPresence p = gson.fromJson(
            "{\"id\":\"628@c.us\",\"state\":\"recording\"}",
            com.rmyndharis.openwa.model.ParticipantPresence.class);
        assertEquals(PresenceState.RECORDING, p.state());

        com.rmyndharis.openwa.model.AccountRestriction a = gson.fromJson(
            "{\"kind\":\"proxy_block\",\"code\":\"X\"}",
            com.rmyndharis.openwa.model.AccountRestriction.class);
        assertEquals(AccountRestrictionKind.PROXY_BLOCK, a.kind());

        com.rmyndharis.openwa.model.GroupInfo g = gson.fromJson(
            "{\"id\":\"g\",\"name\":\"n\",\"memberAddMode\":\"admins\"}",
            com.rmyndharis.openwa.model.GroupInfo.class);
        assertEquals(MemberAddMode.ADMINS, g.memberAddMode());
    }

}

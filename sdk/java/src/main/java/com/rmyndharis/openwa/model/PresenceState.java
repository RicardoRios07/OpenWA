package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** A subscribed contact's presence. */
public enum PresenceState {
    @SerializedName("available") AVAILABLE,
    @SerializedName("unavailable") UNAVAILABLE,
    @SerializedName("composing") COMPOSING,
    @SerializedName("recording") RECORDING,
    @SerializedName("paused") PAUSED
}

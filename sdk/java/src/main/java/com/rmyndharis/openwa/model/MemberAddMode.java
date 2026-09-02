package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Who may add participants to a group. */
public enum MemberAddMode {
    @SerializedName("all") ALL,
    @SerializedName("admins") ADMINS
}

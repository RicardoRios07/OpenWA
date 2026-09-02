package com.rmyndharis.openwa.model;

import java.util.Map;

/** Request body for creating a session. Requires an OPERATOR-level key. */
public record CreateSessionRequest(String name, Map<String, Object> config, String proxyUrl, ProxyType proxyType) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private Map<String, Object> config;
        private String proxyUrl;
        private ProxyType proxyType;

        /** Alphanumeric + hyphens, 3–50 chars. */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        public Builder config(Map<String, Object> v) {
            this.config = v;
            return this;
        }

        public Builder proxyUrl(String v) {
            this.proxyUrl = v;
            return this;
        }

        /** One of {@code http}, {@code https}, {@code socks4}, {@code socks5}. */
        public Builder proxyType(ProxyType v) {
            this.proxyType = v;
            return this;
        }

        public CreateSessionRequest build() {
            return new CreateSessionRequest(name, config, proxyUrl, proxyType);
        }
    }
}

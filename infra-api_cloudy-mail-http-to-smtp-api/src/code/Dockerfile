FROM rust:1.86-slim-bookworm AS builder
WORKDIR /app
COPY Cargo.toml main.rs ./
ENV CARGO_BUILD_JOBS=2
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/http-to-smtp-proxy-api /usr/local/bin/
LABEL org.opencontainers.image.source="https://github.com/diegonmarcos/cloud-infra"
EXPOSE 8090
CMD ["http-to-smtp-proxy-api"]

FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
RUN cd apps/settlement && go mod download && go build -o /settlement ./cmd/settlement

FROM alpine:latest
WORKDIR /app
COPY --from=builder /settlement /app/settlement

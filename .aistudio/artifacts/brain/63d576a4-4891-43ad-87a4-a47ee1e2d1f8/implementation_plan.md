# Implementation Plan - Bid Feed Sorting by Highest Bid

## User Review & Critical Decisions

> [!IMPORTANT]
> This plan updates the live relay bid feed sorting logic so that bids are ordered from highest bid amount to lowest bid amount (descending), with valid bids prioritized at the top and bids below the starting bid displayed below with a muted status indicator.

- **Confirmed Decision 1**: Sort live bid feed by highest bid amount descending.
- **Confirmed Decision 2**: Display invalid/sub-starting bids below valid bids with muted styling.

---

## 1. Overview & Core Concept

- **What It Does**: Sorts the `bids` array before rendering in the Live Relay Bid Feed section. Valid bids ($\ge$ starting bid) are sorted descending by `amountSats`, followed by invalid/below-starting bids.

---

## 2. Technical Architecture & Data Strategy

- **Sorting Logic**:
  ```typescript
  const sortedBids = [...bids].sort((a, b) => {
    const aValid = a.amountSats >= startingBidNum;
    const bValid = b.amountSats >= startingBidNum;
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return b.amountSats - a.amountSats; // Highest bid first
  });
  ```

---

## 3. Verification Plan

1. **Build & Lint Verification**: Run `compile_applet` and `lint_applet`.
2. **UI Verification**: Ensure live feed correctly orders highest bids at the top.

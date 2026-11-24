/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Zap, Radio, Terminal, Clock, Award, 
  ExternalLink, Copy, Check, RefreshCw, AlertCircle, 
  Settings2, CheckCircle2, ShieldAlert
} from 'lucide-react';
import { nip19 } from 'nostr-tools';

interface Bid {
  id: string;
  pubkey: string;
  content: string;
  amountSats: number;
  createdAt: number;
  relayUrl: string;
}

interface RelayStatus {
  url: string;
  connected: boolean;
  eoseReceived: boolean;
  error?: string;
}

const DEFAULT_TEST_NEVENT = "nevent1qgspnzhy9x60m7m66rg9c6rhcwev0k66ahllj72xst799l2sar8wy7sqyz00g9htar9cly8nu9pag5ydrnjtvf0lra7qar4ts4jauyyuh0cavmdttpz";
const DEFAULT_STARTING_BID = 250000;
const DEFAULT_TARGET_BLOCK = 977136;
const BLOCK_POLL_INTERVAL_MS = 60000; // every 60s
const BATCH_FLUSH_DELAY_MS = 120;

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://bitcoiner.social",
  "wss://relay.ditto.pub",
  "wss://relay.dreamith.to",
  "wss://poster.place/relay",
];

function extractEventRefTags(ev: any): string[] {
  const refs: string[] = [];
  if (ev && Array.isArray(ev.tags)) {
    for (const tag of ev.tags) {
      if ((tag[0] === 'e' || tag[0] === 'E') && tag[1]) {
        refs.push(tag[1].toLowerCase());
      }
    }
  }
  return Array.from(new Set(refs));
}

function decodeNeventDetails(input: string): { id: string; relays: string[]; author: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith('nevent1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'nevent') {
      return {
        id: decoded.data.id.toLowerCase(),
        relays: decoded.data.relays || [],
        author: decoded.data.author ? decoded.data.author.toLowerCase() : '',
      };
    }
  } else if (trimmed.startsWith('note1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'note') {
      return { id: decoded.data.toLowerCase(), relays: [], author: '' };
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { id: trimmed.toLowerCase(), relays: [], author: '' };
  }
  return { id: '', relays: [], author: '' };
}

function parseNonNegativeInt(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

function compareBidsDeterministic(a: Bid, b: Bid): number {
  if (b.amountSats !== a.amountSats) return b.amountSats - a.amountSats;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export default function App() {
  // Parse URL parameters or defaults
  const [neventInput, setNeventInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('nevent') || params.get('e') || DEFAULT_TEST_NEVENT;
  });

  const [anchorInput, setAnchorInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('anchor') || '';
  });

  const [showAnchorField, setShowAnchorField] = useState<boolean>(() => Boolean(anchorInput.trim()));

  const [startingBidInput, setStartingBidInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const start = params.get('start') || params.get('starting_bid') || params.get('bid');
    return start !== null ? start : String(DEFAULT_STARTING_BID);
  });

  const [targetBlockInput, setTargetBlockInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const block = params.get('block') || params.get('height') || params.get('closing_block');
    return block !== null ? block : String(DEFAULT_TARGET_BLOCK);
  });

  // Decoded event details
  const [decodedEventId, setDecodedEventId] = useState<string>('');
  const [anchorEventId, setAnchorEventId] = useState<string>('');
  const [decodedRelays, setDecodedRelays] = useState<string[]>(DEFAULT_RELAYS);
  const [authorPubkey, setAuthorPubkey] = useState<string>('');

  // Live Bitcoin Block Height & Closing Block Timestamp
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number | null>(null);
  const [closingBlockTimestamp, setClosingBlockTimestamp] = useState<number | null>(null);
  const [wasLiveBeforeClose, setWasLiveBeforeClose] = useState<boolean>(true);
  const [wsBlockConnected, setWsBlockConnected] = useState<boolean>(false);
  const [isLiveBlockFetching, setIsLiveBlockFetching] = useState<boolean>(true);
  const [blockFetchError, setBlockFetchError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // Bids state
  const [bids, setBids] = useState<Bid[]>([]);
  const [relaysStatus, setRelaysStatus] = useState<RelayStatus[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [showTesterModal, setShowTesterModal] = useState<boolean>(false);
  const [finalizedWinner, setFinalizedWinner] = useState<Bid | null>(null);
  const [winnerDisplayedAt, setWinnerDisplayedAt] = useState<string | null>(null);
  const [auctionFinalized, setAuctionFinalized] = useState<boolean>(false);

  // WebSocket & block-state refs
  const stopRelayConnectionsRef = useRef<(() => void) | null>(null);
  const bidsRef = useRef<Bid[]>([]);
  const wasLiveBeforeCloseRef = useRef<boolean>(true);
  const currentBlockHeightRef = useRef<number | null>(null);
  const liveCloseLockedRef = useRef<boolean>(false);
  const finalizationSnapshotRef = useRef<Bid[] | null>(null);
  const finalizationStartedRef = useRef<boolean>(false);
  const timestampFetchInFlightRef = useRef<boolean>(false);
  const targetBlockNumRef = useRef<number>(DEFAULT_TARGET_BLOCK);
  const initialBlockLoadedRef = useRef<boolean>(false);
  const wsConnectedRef = useRef<boolean>(false);

  const targetBlockNum = parseNonNegativeInt(targetBlockInput, DEFAULT_TARGET_BLOCK);
  const startingBidNum = parseNonNegativeInt(startingBidInput, DEFAULT_STARTING_BID);

  useEffect(() => {
    targetBlockNumRef.current = targetBlockNum;
  }, [targetBlockNum]);

  // Parse primary + optional secondary anchor relay hints using nostr-tools
  useEffect(() => {
    try {
      const primary = decodeNeventDetails(neventInput);
      const secondary = anchorInput.trim() ? decodeNeventDetails(anchorInput) : { id: '', relays: [], author: '' };

      const eventId = primary.id || "7f70b7952e379bc5943b7e7a7a58a74b1e4c32b535d4f3b7d8b53d4f3b7d8b53";
      const normalizedRelays = Array.from(
        new Set(
          [...primary.relays, ...secondary.relays, ...DEFAULT_RELAYS]
            .map(u => u.trim().replace(/\/+$/, ''))
            .filter(u => u.startsWith('wss://') || u.startsWith('ws://'))
        )
      );

      setDecodedEventId(eventId);
      setAnchorEventId(secondary.id);
      setDecodedRelays(normalizedRelays);
      setAuthorPubkey(primary.author || secondary.author || '');

      setRelaysStatus(normalizedRelays.map(url => ({
        url,
        connected: false,
        eoseReceived: false
      })));
    } catch (err) {
      console.error("Failed to decode nevent:", err);
      setDecodedEventId(neventInput);
      setAnchorEventId('');
      setDecodedRelays(DEFAULT_RELAYS);
      setRelaysStatus(DEFAULT_RELAYS.map(url => ({ url, connected: false, eoseReceived: false })));
    }
  }, [neventInput, anchorInput]);

  // Reset auction-finalization state when the auction parameters change.
  useEffect(() => {
    setFinalizedWinner(null);
    setWinnerDisplayedAt(null);
    setAuctionFinalized(false);
    const alreadyPastClosingBlock = currentBlockHeightRef.current !== null && currentBlockHeightRef.current >= targetBlockNum;
    setWasLiveBeforeClose(!alreadyPastClosingBlock);
    wasLiveBeforeCloseRef.current = !alreadyPastClosingBlock;
    liveCloseLockedRef.current = false;
    finalizationSnapshotRef.current = null;
    finalizationStartedRef.current = false;
    timestampFetchInFlightRef.current = false;
    initialBlockLoadedRef.current = currentBlockHeightRef.current !== null;
  }, [decodedEventId, anchorEventId, startingBidNum, targetBlockNum]);

  const fetchClosingBlockTimestamp = useCallback(async (blockHeight: number): Promise<number | null> => {
    try {
      const hashRes = await fetch(`https://mempool.space/api/block-height/${blockHeight}`, { cache: 'no-store' });
      if (!hashRes.ok) return null;
      const blockHash = (await hashRes.text()).trim();
      if (!blockHash) return null;
      const blockRes = await fetch(`https://mempool.space/api/block/${blockHash}`, { cache: 'no-store' });
      if (!blockRes.ok) return null;
      const blockData = await blockRes.json();
      if (typeof blockData.timestamp === 'number') return blockData.timestamp;
      return null;
    } catch (tsErr) {
      console.warn("Failed to fetch closing block timestamp:", tsErr);
      return null;
    }
  }, []);

  // The first target-height observation freezes the bids already received by this browser.
  // Later relay events are ignored, even if their Nostr created_at value is backdated.
  const finalizeLiveAuction = useCallback((blockTimestamp: number) => {
    if (finalizationStartedRef.current || !wasLiveBeforeCloseRef.current) return;
    finalizationStartedRef.current = true;
    setClosingBlockTimestamp(blockTimestamp);

    const snapshot = finalizationSnapshotRef.current || bidsRef.current;
    const winner = [...snapshot]
      .filter(b => b.amountSats >= startingBidNum && b.createdAt <= blockTimestamp)
      .sort(compareBidsDeterministic)[0] || null;

    setFinalizedWinner(winner);
    if (winner) {
      // This is the browser's local display time, not a timestamp certified by Bitcoin or Nostr.
      setWinnerDisplayedAt(new Date().toISOString());
    }
    setAuctionFinalized(true);
    setShowTesterModal(false);
    stopRelayConnectionsRef.current?.();
  }, [startingBidNum]);

  const applyObservedBlockHeight = useCallback((height: number, fromInitialLoad: boolean, observedBlockTimestamp?: number) => {
    if (isNaN(height) || height <= 0) return;
    currentBlockHeightRef.current = currentBlockHeightRef.current === null ? height : Math.max(currentBlockHeightRef.current, height);
    setCurrentBlockHeight(prev => (prev === null || height > prev ? height : prev));
    setLastSyncedAt(Math.floor(Date.now() / 1000));
    setBlockFetchError(null);

    // Let the initial HTTP tip check decide whether this page arrived after the close.
    // A block-stream frame can arrive before that request finishes.
    if (!fromInitialLoad && !initialBlockLoadedRef.current) return;

    const target = targetBlockNumRef.current;
    if (height >= target) {
      if (fromInitialLoad) {
        setWasLiveBeforeClose(false);
        wasLiveBeforeCloseRef.current = false;
      } else if (wasLiveBeforeCloseRef.current && !liveCloseLockedRef.current) {
        liveCloseLockedRef.current = true;
        finalizationSnapshotRef.current = [...bidsRef.current];
      }

      if (wasLiveBeforeCloseRef.current && liveCloseLockedRef.current) {
        if (typeof observedBlockTimestamp === 'number') {
          finalizeLiveAuction(observedBlockTimestamp);
        } else if (!finalizationStartedRef.current && !timestampFetchInFlightRef.current) {
          timestampFetchInFlightRef.current = true;
          fetchClosingBlockTimestamp(target).then(timestamp => {
            timestampFetchInFlightRef.current = false;
            if (timestamp !== null) {
              finalizeLiveAuction(timestamp);
            }
          });
        }
      } else {
        // Historical page load: retain relay subscriptions so stored events can reach EOSE.
        fetchClosingBlockTimestamp(target).then(timestamp => {
          if (timestamp !== null) setClosingBlockTimestamp(timestamp);
        });
      }
    } else {
      setClosingBlockTimestamp(null);
    }
    initialBlockLoadedRef.current = true;
  }, [fetchClosingBlockTimestamp, finalizeLiveAuction]);

  // Single initial HTTP fetch on load (and manual refresh / low-frequency fallback)
  const fetchBlockHeight = useCallback(async () => {
    setIsLiveBlockFetching(true);
    const isFirstLoad = !initialBlockLoadedRef.current;
    try {
      const res = await fetch('https://mempool.space/api/blocks/tip/height', { cache: 'no-store' });
      if (!res.ok) throw new Error("Failed to fetch block height");
      const heightText = await res.text();
      const height = parseInt(heightText.trim(), 10);
      if (!isNaN(height) && height > 0) {
        applyObservedBlockHeight(height, isFirstLoad);
      }
    } catch (err) {
      console.warn("Mempool API fetch error:", err);
      setBlockFetchError("Mempool API unreachable");
    } finally {
      setIsLiveBlockFetching(false);
    }
  }, [applyObservedBlockHeight]);

  useEffect(() => {
    fetchBlockHeight();
  }, [fetchBlockHeight]);

  // Instant block updates via mempool.space WebSocket with reconnect backoff (stable lifecycle)
  useEffect(() => {
    let closedByCleanup = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
    let activeWs: WebSocket | null = null;

    const setConnectedState = (connected: boolean) => {
      wsConnectedRef.current = connected;
      setWsBlockConnected(connected);
    };

    const connectBlockWs = () => {
      if (closedByCleanup) return;
      try {
        const ws = new WebSocket('wss://mempool.space/api/v1/ws');
        activeWs = ws;

        ws.onopen = () => {
          if (closedByCleanup || activeWs !== ws) {
            ws.close();
            return;
          }
          reconnectAttempt = 0;
          setConnectedState(true);
          setBlockFetchError(null);
          setIsLiveBlockFetching(false);
          ws.send(JSON.stringify({ action: "want", data: ["blocks"] }));
        };

        ws.onmessage = (event) => {
          if (closedByCleanup || activeWs !== ws) return;
          try {
            const msg = JSON.parse(event.data);
            if (typeof msg?.block?.height === 'number') {
              applyObservedBlockHeight(msg.block.height, false, msg.block.timestamp);
            } else if (typeof msg?.blocks?.height === 'number') {
              applyObservedBlockHeight(msg.blocks.height, false);
            } else if (Array.isArray(msg?.blocks) && msg.blocks.length > 0 && typeof msg.blocks[0]?.height === 'number') {
              applyObservedBlockHeight(msg.blocks[0].height, false);
            } else if (typeof msg?.['mempool-blocks'] !== 'undefined') {
              setLastSyncedAt(Math.floor(Date.now() / 1000));
            }
          } catch (e) {
            console.warn("Failed to parse mempool WS frame:", e);
          }
        };

        ws.onerror = () => {
          if (activeWs === ws) {
            setConnectedState(false);
          }
        };

        ws.onclose = () => {
          if (activeWs === ws) {
            activeWs = null;
            setConnectedState(false);
          }
          if (closedByCleanup) return;
          const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(connectBlockWs, delayMs);
        };
      } catch (e) {
        setConnectedState(false);
        if (!closedByCleanup) {
          const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(connectBlockWs, delayMs);
        }
      }
    };

    connectBlockWs();

    fallbackPollTimer = setInterval(() => {
      if (!closedByCleanup && !wsConnectedRef.current) {
        fetchBlockHeight();
      }
    }, BLOCK_POLL_INTERVAL_MS);

    return () => {
      closedByCleanup = true;
      setConnectedState(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackPollTimer) clearInterval(fallbackPollTimer);
      if (activeWs && (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING)) {
        activeWs.close();
      }
    };
  }, [applyObservedBlockHeight, fetchBlockHeight]);

  const auctionClosed = currentBlockHeight !== null && currentBlockHeight >= targetBlockNum;

  // Deterministic bid classification & winner calculation. A live auction uses its
  // immutable finalized winner after the closing block has been witnessed.
  const sortedBids = [...bids].sort(compareBidsDeterministic);

  const validBids = sortedBids.filter(b => {
    if (b.amountSats < startingBidNum) return false;
    if (closingBlockTimestamp !== null && b.createdAt > closingBlockTimestamp) return false;
    return true;
  });

  const highestBid = validBids.length > 0 ? validBids[0] : null;
  const displayedWinner = auctionClosed && wasLiveBeforeClose ? finalizedWinner : highestBid;
  const showcaseBid = auctionClosed && wasLiveBeforeClose
    ? (finalizedWinner || (!auctionFinalized ? highestBid : null))
    : highestBid;
  const connectedRelays = relaysStatus.filter(r => r.connected);

  // Connect to Relays WebSocket with batched deduplicated ID walking & per-relay EOSE tracking
  useEffect(() => {
    if (!decodedEventId || decodedRelays.length === 0) return;

    // A live auction already locked at its target block must never reconnect to relays.
    if (liveCloseLockedRef.current) return;

    setIsListening(true);
    setBids([]);
    bidsRef.current = [];
    const newWsRefs: { [url: string]: WebSocket } = {};
    let stopped = false;

    const rootEventIds = Array.from(
      new Set([decodedEventId, anchorEventId].map(id => id.toLowerCase()).filter(Boolean))
    );

    const discoveredEventIds = new Set<string>(rootEventIds);
    const queuedWalkIds = new Set<string>(rootEventIds);
    const pendingBatchIds = new Set<string>();
    const seenEventIds = new Set<string>();
    const pendingByParentId = new Map<string, Array<{ ev: any; relayUrl: string }>>();
    const activeSubRelayMap = new Map<string, string>(); // subId -> relayUrl
    const relayPendingSubs = new Map<string, Set<string>>(); // relayUrl -> Set<subId>

    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const stopConnections = () => {
      if (stopped) return;
      stopped = true;
      if (batchTimer !== null) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      pendingBatchIds.clear();
      Object.values(newWsRefs).forEach(sock => {
        if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
          try { sock.close(); } catch (e) { console.warn("Failed to close relay socket:", e); }
        }
      });
      setIsListening(false);
      setRelaysStatus(prev => prev.map(r => ({ ...r, connected: false })));
    };
    stopRelayConnectionsRef.current = stopConnections;

    const markRelayEoseIfReady = (relayUrl: string) => {
      if (stopped || liveCloseLockedRef.current) return;
      const pending = relayPendingSubs.get(relayUrl);
      if (!pending || pending.size === 0) {
        setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, eoseReceived: true } : r));
      }
    };

    const registerSubscription = (ws: WebSocket, relayUrl: string, subId: string, filter: Record<string, any>) => {
      if (stopped || liveCloseLockedRef.current) return;
      activeSubRelayMap.set(subId, relayUrl);
      let setForRelay = relayPendingSubs.get(relayUrl);
      if (!setForRelay) {
        setForRelay = new Set<string>();
        relayPendingSubs.set(relayUrl, setForRelay);
      }
      setForRelay.add(subId);
      setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, eoseReceived: false } : r));

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      }
    };

    const flushBatchedWalkIds = () => {
      batchTimer = null;
      if (stopped || liveCloseLockedRef.current) return;
      if (pendingBatchIds.size === 0) return;

      const batch = Array.from(pendingBatchIds);
      pendingBatchIds.clear();

      const batchToken = `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

      Object.entries(newWsRefs).forEach(([relayUrl, sock]) => {
        if (sock.readyState === WebSocket.OPEN) {
          const subE = `walk_e_${batchToken}`;
          const subUpperE = `walk_E_${batchToken}`;
          const subIds = `walk_ids_${batchToken}`;

          registerSubscription(sock, relayUrl, subE, { kinds: [1, 1111], '#e': batch, limit: 500 });
          registerSubscription(sock, relayUrl, subUpperE, { kinds: [1, 1111], '#E': batch, limit: 500 });
          registerSubscription(sock, relayUrl, subIds, { kinds: [1, 1111], ids: batch, limit: 250 });
        }
      });
    };

    const scheduleWalkTargets = (targets: string[]) => {
      if (stopped || liveCloseLockedRef.current) return;
      let addedAny = false;
      for (const rawId of targets) {
        const targetId = rawId.toLowerCase();
        if (!targetId || queuedWalkIds.has(targetId)) continue;
        queuedWalkIds.add(targetId);
        pendingBatchIds.add(targetId);
        addedAny = true;
      }

      if (addedAny && batchTimer === null) {
        batchTimer = setTimeout(flushBatchedWalkIds, BATCH_FLUSH_DELAY_MS);
      }
    };

    const acceptThreadEvent = (ev: any, eventRefTags: string[], relayUrl: string) => {
      if (stopped || liveCloseLockedRef.current) return;
      const evId = ev.id.toLowerCase();
      parseAndAddBid({ ...ev, id: evId, pubkey: ev.pubkey.toLowerCase() }, relayUrl, seenEventIds);

      const newlyDiscovered = !discoveredEventIds.has(evId);
      discoveredEventIds.add(evId);

      // Walk both the event's own ID (for child replies) and all its e/E references (for parent/root events)
      scheduleWalkTargets([evId, ...eventRefTags]);

      // Flush any out-of-order children waiting on this event ID
      if (newlyDiscovered && pendingByParentId.has(evId)) {
        const queued = pendingByParentId.get(evId) || [];
        pendingByParentId.delete(evId);
        for (const item of queued) {
          acceptThreadEvent(item.ev, extractEventRefTags(item.ev), item.relayUrl);
        }
      }
    };

    decodedRelays.forEach(relayUrl => {
      try {
        const ws = new WebSocket(relayUrl);
        newWsRefs[relayUrl] = ws;

        ws.onopen = () => {
          if (stopped || liveCloseLockedRef.current) { ws.close(); return; }
          relayPendingSubs.set(relayUrl, new Set<string>());
          setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, connected: true, eoseReceived: false, error: undefined } : r));

          const allKnownIds = Array.from(discoveredEventIds);
          const initToken = Math.random().toString(36).substring(2, 8);

          // 1. Batched root subscriptions (#e, #E, and direct ids across kinds 1 and 1111)
          registerSubscription(ws, relayUrl, `roots_e_${initToken}`, { kinds: [1, 1111], '#e': allKnownIds, limit: 500 });
          registerSubscription(ws, relayUrl, `roots_E_${initToken}`, { kinds: [1, 1111], '#E': allKnownIds, limit: 500 });
          registerSubscription(ws, relayUrl, `roots_ids_${initToken}`, { kinds: [1, 1111], ids: allKnownIds, limit: 250 });

          // 2. Author notes query if authorPubkey is known
          if (authorPubkey) {
            registerSubscription(ws, relayUrl, `author_${initToken}`, { kinds: [1, 1111], authors: [authorPubkey], limit: 250 });
          }

          markRelayEoseIfReady(relayUrl);
        };

        ws.onmessage = (event) => {
          if (stopped || liveCloseLockedRef.current) return;
          try {
            const data = JSON.parse(event.data);
            if (!Array.isArray(data)) return;

            if (data[0] === 'EOSE' && typeof data[1] === 'string') {
              const subId = data[1];
              const subRelay = activeSubRelayMap.get(subId) || relayUrl;
              const pending = relayPendingSubs.get(subRelay);
              if (pending) {
                pending.delete(subId);
              }
              markRelayEoseIfReady(subRelay);
              return;
            }

            if (data[0] === 'EVENT' && data[2]) {
              const ev = data[2];
              if (!ev.id || !ev.pubkey) return;
              const evId = ev.id.toLowerCase();
              const eventRefTags = extractEventRefTags(ev);

              // Check if event belongs to thread graph (is a root/discovered ID or tags any root/discovered ID)
              const belongsToThread =
                discoveredEventIds.has(evId) ||
                eventRefTags.some(refTag => discoveredEventIds.has(refTag));

              if (belongsToThread) {
                acceptThreadEvent(ev, eventRefTags, relayUrl);
              } else if (eventRefTags.length > 0 && !seenEventIds.has(evId)) {
                // Queue until one of its referenced parent/thread events arrives, and batch-query those parent IDs
                for (const refTag of eventRefTags) {
                  const list = pendingByParentId.get(refTag) || [];
                  if (!list.some(item => item.ev.id.toLowerCase() === evId)) {
                    list.push({ ev, relayUrl });
                    pendingByParentId.set(refTag, list);
                  }
                }
                scheduleWalkTargets(eventRefTags);
              }
            }
          } catch (e) {
            console.error("Error parsing WS message from", relayUrl, e);
          }
        };

        ws.onerror = (err) => {
          if (stopped) return;
          console.warn("Relay error:", relayUrl, err);
          setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, connected: false, error: 'Connection error' } : r));
        };

        ws.onclose = () => {
          setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, connected: false } : r));
        };
      } catch (e) {
        console.error("Failed to connect to relay", relayUrl, e);
      }
    });

    return () => {
      stopConnections();
      if (stopRelayConnectionsRef.current === stopConnections) {
        stopRelayConnectionsRef.current = null;
      }
    };
  }, [decodedEventId, anchorEventId, decodedRelays, authorPubkey]);

  // Parse Nostr event content to extract bid amounts in satoshis across nested threads
  const parseAndAddBid = (ev: any, relayUrl: string, seenSet?: Set<string>) => {
    if (liveCloseLockedRef.current) return;
    if (!ev || !ev.content || !ev.id || !ev.pubkey) return;
    const evId = ev.id.toLowerCase();
    if (seenSet && seenSet.has(evId)) return;
    if (seenSet) seenSet.add(evId);

    const content = ev.content;
    const amount = extractSatsFromText(content);

    if (amount && amount > 0) {
      const newBid: Bid = {
        id: evId,
        pubkey: ev.pubkey.toLowerCase(),
        content: content,
        amountSats: amount,
        createdAt: typeof ev.created_at === 'number' ? ev.created_at : Math.floor(Date.now() / 1000),
        relayUrl: relayUrl
      };

      if (bidsRef.current.some(b => b.id === newBid.id)) return;
      const nextBids = [...bidsRef.current, newBid].sort(compareBidsDeterministic);
      bidsRef.current = nextBids;
      setBids(nextBids);
    }
  };

  const extractSatsFromText = (text: string): number | null => {
    const cleanText = text.toLowerCase().replace(/,/g, '');

    // 1. Explicit BTC amount (e.g. "0.005 btc", "0.01btc")
    const btcMatch = cleanText.match(/(?:^|[^\w.])(\d*\.?\d+)\s*btc\b/);
    if (btcMatch) {
      const btc = parseFloat(btcMatch[1]);
      if (!isNaN(btc) && btc > 0 && btc < 21000000) {
        return Math.round(btc * 100000000);
      }
    }

    // 2. Explicit sats / sat / satoshis
    const satsMatch = cleanText.match(/(?:^|[^\w.])(\d+)\s*(?:sats?|satoshis?)\b/);
    if (satsMatch) {
      const sats = parseInt(satsMatch[1], 10);
      if (!isNaN(sats) && sats > 0) return sats;
    }

    // 3. Explicit "k" thousands shorthand (e.g. "650k", "680k", "1.25k")
    const kMatch = cleanText.match(/(?:^|[^\w.])(\d*\.?\d+)\s*k\b/);
    if (kMatch) {
      const num = parseFloat(kMatch[1]);
      if (!isNaN(num) && num > 0) return Math.round(num * 1000);
    }

    // 4. Explicit "m" millions shorthand (e.g. "1m", "1.5m")
    const mMatch = cleanText.match(/(?:^|[^\w.])(\d*\.?\d+)\s*m\b/);
    if (mMatch) {
      const num = parseFloat(mMatch[1]);
      if (!isNaN(num) && num > 0) return Math.round(num * 1000000);
    }

    // 5. Fallback: standalone integer >= 1,000,000 (avoids small numbers, block heights like 977136, etc.)
    const largeNumbers = cleanText.match(/\b\d{7,10}\b/g);
    if (largeNumbers && largeNumbers.length > 0) {
      const val = parseInt(largeNumbers[0], 10);
      if (!isNaN(val) && val >= 1000000) return val;
    }

    return null;
  };

  // Helper to inject a simulated incoming bid for testing
  const injectSimulatedBid = (sats: number, name: string) => {
    if (liveCloseLockedRef.current || auctionFinalized) return;
    const fakeId = `sim_${Math.random().toString(16).substring(2, 10)}`;
    const fakePubkey = `npub1${name.toLowerCase()}000000000000000000000000000000000000000000`;
    const simulatedBid: Bid = {
      id: fakeId,
      pubkey: fakePubkey,
      content: `I am bidding ${sats.toLocaleString()} sats in this auction! Let's win this item.`,
      amountSats: sats,
      createdAt: Math.floor(Date.now() / 1000),
      relayUrl: decodedRelays[0] || 'wss://relay.damus.io'
    };

    const nextBids = [...bidsRef.current, simulatedBid].sort(compareBidsDeterministic);
    bidsRef.current = nextBids;
    setBids(nextBids);
  };

  // Generate shareable URL
  const generateShareUrl = () => {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('nevent', neventInput);
    if (anchorInput.trim()) {
      url.searchParams.set('anchor', anchorInput.trim());
    }
    url.searchParams.set('start', startingBidInput);
    url.searchParams.set('block', targetBlockInput);
    return url.toString();
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(generateShareUrl());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  const formatBtc = (sats: number) => {
    return (sats / 100000000).toFixed(8) + " BTC";
  };

  const truncatePubkey = (pubkey: string) => {
    if (!pubkey) return 'Unknown';
    if (pubkey.startsWith('npub1')) {
      return pubkey.substring(0, 8) + '...' + pubkey.substring(pubkey.length - 4);
    }
    try {
      const npub = nip19.npubEncode(pubkey);
      return npub.substring(0, 8) + '...' + npub.substring(npub.length - 4);
    } catch {
      return pubkey.substring(0, 8) + '...' + pubkey.substring(pubkey.length - 4);
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500/30 selection:text-amber-200">
      
      {/* Top Bar Contract (stacked on mobile, single row on desktop) */}
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-8 px-4 sm:px-6 py-4 border-b border-slate-800/80 bg-slate-900/55 backdrop-blur-md sticky top-0 z-50">
        
        {/* Left group: Logo/wordmark + mobile Configure Auction button directly underneath */}
        <div className="flex flex-col items-start gap-2.5 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 64 64"
              width="64"
              height="64"
              className="w-8 h-8 rounded-[14px] shrink-0"
              aria-label="NostrAuction ostrich gavel icon"
            >
              <rect x="0" y="0" width="64" height="64" rx="14" fill="#EED9B5" />
              <ellipse cx="36.5" cy="29" rx="13" ry="10.5" fill="#1E2022" />
              <g transform="translate(13.5,18) rotate(-42)">
                <rect x="-1.1" y="1.8" width="2.2" height="14.5" rx="0.8" fill="#6D4C41" stroke="#3E2723" strokeWidth="0.7" />
                <rect x="-4.5" y="-1.8" width="9" height="3.6" rx="0.8" fill="#5D4037" stroke="#3E2723" strokeWidth="0.7" />
                <rect x="-5.5" y="-2.2" width="1.6" height="4.4" rx="0.5" fill="#4E342E" stroke="#3E2723" strokeWidth="0.7" />
                <rect x="3.9" y="-2.2" width="1.6" height="4.4" rx="0.5" fill="#4E342E" stroke="#3E2723" strokeWidth="0.7" />
              </g>
              <path
                d="M30 23 C25 22.5 19.5 23.5 18 26.5 C17 29 21 31.5 27.5 31.5 C31.5 31.5 33 26.5 30 23 Z"
                fill="#F5EFE0"
                stroke="#454A52"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <path
                d="M20.5 26.2 Q24.5 25.8 27.5 27.2"
                fill="none"
                stroke="#454A52"
                strokeWidth="1"
                strokeLinecap="round"
              />
              <path
                d="M33.5 25.5 C31.5 24 30.5 26.5 32.5 28 C31 29 32.5 31.5 34.5 30.5 C35.5 32.5 38 32.5 39 30.5 C41 31.5 42.5 29 41 28 C43 26.5 42 24 40 25.5 Z"
                fill="#F5EFE0"
                stroke="#1E2022"
                strokeWidth="1"
                strokeLinejoin="round"
              />
              <path
                d="M35 27 C36 22 40.5 19 37 14 C34.5 10.5 33.5 9 33.5 7 L37 7 C37 9 38 10.5 40.5 14 C44 19 39.5 22 38.5 27 Z"
                fill="#F5EFE0"
                stroke="#1E2022"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <path
                d="M39 5.8 Q45 5.8 46 7.4 Q45 9 39 8.8 Z"
                fill="#C9A9A6"
                stroke="#1E2022"
                strokeWidth="1"
                strokeLinejoin="round"
              />
              <path d="M39.5 7.4 L45.5 7.4" stroke="#1E2022" strokeWidth="0.8" strokeLinecap="round" />
              <path
                d="M31.5 8.5 Q29.5 7.5 31 6 Q30 4.2 32 4.5 Q32 2.5 34 3.5 Q35 1.8 36.5 3.5 Q39 3.5 39.5 6.5 Q39.5 9.5 36 9.8 Q32.5 9.8 31.5 8.5 Z"
                fill="#F5EFE0"
                stroke="#1E2022"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <circle cx="36.3" cy="6.2" r="1.5" fill="#1E2022" />
              <circle cx="36.7" cy="5.8" r="0.5" fill="#FFFFFF" />
              <path
                d="M7 36 L57 36 L53.5 59.5 Q53 60.5 52 60.5 L12 60.5 Q11 60.5 10.5 59.5 Z"
                fill="#655A4E"
                stroke="#807153"
                strokeWidth="1.1"
              />
              <rect x="5" y="33.5" width="54" height="4.8" rx="1.8" fill="#655A4E" stroke="#807153" strokeWidth="1.1" />
            </svg>
            <span className="text-base sm:text-lg font-bold tracking-tight text-white">
              NostrAuction <span className="text-amber-400 font-mono text-[11px] sm:text-xs ml-1 px-1.5 sm:px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">AUCTION TERMINAL</span>
            </span>
          </div>

          {/* Mobile/tablet button directly below logo/title, left-aligned */}
          <button
            type="button"
            onClick={() => setShowTesterModal(true)}
            disabled={auctionFinalized && wasLiveBeforeClose}
            className="flex md:hidden items-center gap-2 px-3.5 py-1.5 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-lg shadow-amber-400/10 cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Configure Auction
          </button>
        </div>

        {/* Desktop navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a href="#auction-hero" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Auction Details</a>
          <a href="#highest-bidder" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Highest Bid</a>
          <a href="#live-feed" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Bids</a>
          <a href="#relays" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Relays</a>
        </nav>

        {/* Desktop action button */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          <button 
            type="button"
            onClick={() => setShowTesterModal(true)}
            disabled={auctionFinalized && wasLiveBeforeClose}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-lg shadow-amber-400/10 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Configure Auction
          </button>
        </div>

      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-8">

        {/* Warning when page was not live before closing block was mined */}
        {auctionClosed && !wasLiveBeforeClose && (
          <div className="rounded-xl bg-amber-950/50 border border-amber-500/40 p-4 flex items-start gap-3 text-xs font-mono text-amber-200">
            <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold uppercase tracking-wider text-amber-300 block mb-0.5">
                Not Live-Witnessed Prior to Block #{targetBlockNum.toLocaleString()}
              </span>
              The closing block was already mined before this page loaded and reached the End of Stored Events (EOSE). Historical bid arrival times were not live-witnessed in real time — auctioneer judgment is advised.
            </div>
          </div>
        )}

        {/* Winner / Auction Closed Notification Banner */}
        {auctionClosed && displayedWinner && (
          <div className="rounded-2xl bg-gradient-to-r from-emerald-950/80 via-slate-900 to-amber-950/50 border border-emerald-500/40 p-6 shadow-2xl relative overflow-hidden animate-fade-in">
            <div className="absolute -right-10 -bottom-10 w-60 h-60 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative z-10">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                  <Award className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 font-mono uppercase tracking-wider mb-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Auction Concluded at Block #{targetBlockNum}
                  </div>
                  <h2 className="text-xl font-bold text-white tracking-tight">
                    Winning Bid Confirmed: {displayedWinner.amountSats.toLocaleString()} sats ({formatBtc(displayedWinner.amountSats)})
                  </h2>
                  <p className="text-sm text-slate-300 mt-1">
                    Winner Npub: <span className="font-mono text-amber-300">{truncatePubkey(displayedWinner.pubkey)}</span> · Event ID: <span className="font-mono text-slate-400 text-xs">{displayedWinner.id.substring(0, 16)}...</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <a 
                  href={`https://njump.me/${displayedWinner.id}`} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition-colors shadow-lg shadow-emerald-600/20 whitespace-nowrap"
                >
                  View Winning Note on Njump <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {wasLiveBeforeClose && winnerDisplayedAt && (
                  <span className="text-[11px] text-slate-400 font-mono whitespace-nowrap">
                    Winner displayed: {new Date(winnerDisplayedAt).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Hero Section: Auction Overview & Status */}
        <section id="auction-hero" className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
          
          {/* Left 2 Cols: Auction Details Card */}
          <div className="lg:col-span-2 rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 md:p-8 flex flex-col justify-between shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl pointer-events-none"></div>
            
            <div>
              <div className="flex items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-400 font-mono">
                  <span>AUCTION EVENT (NEVENT)</span>
                </div>
                <div className={`px-2.5 py-1 rounded-full text-xs font-semibold font-mono flex items-center gap-1.5 ${
                  auctionClosed ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${auctionClosed ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`}></span>
                  {auctionClosed ? 'CLOSED (BLOCK REACHED)' : 'LIVE AUCTION'}
                </div>
              </div>

              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3">
                Nostr Nsite Bitcoin Auction
              </h1>
              
              <p className="text-sm text-slate-400 font-mono break-all bg-slate-950/60 p-3 rounded-xl border border-slate-800/60 mb-6">
                {neventInput}
              </p>

              {/* Specs Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
                <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/60">
                  <span className="text-xs text-slate-400 font-mono block mb-1">Starting Bid</span>
                  <span className="text-lg font-bold text-white font-mono tabular-nums">
                    {startingBidNum.toLocaleString()} <span className="text-xs font-normal text-amber-400">sats</span>
                  </span>
                </div>

                <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/60">
                  <span className="text-xs text-slate-400 font-mono block mb-1">Closing Block Height</span>
                  <span className="text-lg font-bold text-amber-400 font-mono tabular-nums">
                    #{targetBlockNum.toLocaleString()}
                  </span>
                </div>

                <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/60 col-span-2 sm:col-span-1">
                  <span className="text-xs text-slate-400 font-mono block mb-1">Total Valid Bids</span>
                  <span className="text-lg font-bold text-white font-mono tabular-nums">
                    {validBids.length}
                  </span>
                </div>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-800/60">
              <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                <Terminal className="w-4 h-4 text-amber-400" />
                <span>Decoded Event ID: <span className="text-slate-200">{decodedEventId.substring(0, 12)}...</span></span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyShareLink}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedLink ? 'Copied Share URL!' : 'Share Nsite URL'}
                </button>
                <a
                  href={`https://njump.me/${neventInput}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open on Njump
                </a>
              </div>
            </div>

          </div>

          {/* Right Col: Live Mempool.space Block Height Tracker */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 flex flex-col justify-between shadow-xl">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-medium text-slate-400 font-mono uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" /> Bitcoin Block Height
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
                    wsBlockConnected
                      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                      : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                  }`}>
                    {wsBlockConnected ? 'WS STREAM LIVE' : 'WS RECONNECTING'}
                  </span>
                  <button
                    type="button"
                    onClick={fetchBlockHeight}
                    title="Refresh block height from mempool.space"
                    className="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isLiveBlockFetching ? 'animate-spin text-amber-400' : ''}`} />
                  </button>
                </div>
              </div>

              <div className="bg-slate-950/70 p-5 rounded-xl border border-slate-800/80 mb-4 text-center">
                <span className="text-xs text-slate-400 font-mono block mb-1">Current Chain Tip</span>
                <div className="text-3xl font-bold font-mono text-white tabular-nums tracking-tight">
                  {currentBlockHeight !== null ? `#${currentBlockHeight.toLocaleString()}` : 'Syncing...'}
                </div>
                <div className="text-xs text-slate-400 mt-2 font-mono">
                  {currentBlockHeight === null ? (
                    <span>Syncing with mempool.space...</span>
                  ) : auctionClosed ? (
                    <span className="text-amber-400 font-semibold">Auction Closed (Target Reached)</span>
                  ) : (
                    <span>Blocks Remaining: <strong className="text-amber-400">{(targetBlockNum - currentBlockHeight).toLocaleString()}</strong></span>
                  )}
                </div>
              </div>

              <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/60 space-y-2 text-xs font-mono text-slate-400">
                <div className="flex justify-between">
                  <span>Stream</span>
                  <span className="text-amber-400">wss://mempool.space/api/v1/ws</span>
                </div>
                <div className="flex justify-between">
                  <span>Poll Interval</span>
                  <span className="text-slate-200">{BLOCK_POLL_INTERVAL_MS / 1000}s</span>
                </div>
                <div className="flex justify-between">
                  <span>Last Synced</span>
                  <span className="text-slate-200 tabular-nums">
                    {lastSyncedAt ? new Date(lastSyncedAt * 1000).toLocaleTimeString() : 'Never'}
                  </span>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-slate-400 font-mono pt-4 text-center">
              Mempool WS: {wsBlockConnected ? 'Connected ⚡' : (blockFetchError || 'Reconnecting...')}
            </div>
          </div>

        </section>

        {/* Highest Bidder Showcase */}
        <section id="highest-bidder" className="rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900 to-amber-950/20 border border-amber-500/30 p-6 md:p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
                <Zap className="w-4 h-4" />
              </div>
              <h2 className="text-lg font-bold text-white tracking-tight">Current Highest Bidder</h2>
            </div>
          </div>

          {showcaseBid ? (
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div className="space-y-3 flex-1">
                <div className="text-3xl sm:text-4xl font-bold font-mono text-amber-400 tabular-nums tracking-tight">
                  {(showcaseBid as Bid).amountSats.toLocaleString()} <span className="text-lg font-normal text-slate-300">sats</span>
                  <span className="text-sm font-normal text-slate-400 ml-3">({formatBtc((showcaseBid as Bid).amountSats)})</span>
                </div>
                <p className="text-sm text-slate-300 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 italic font-mono">
                  "{(showcaseBid as Bid).content}"
                </p>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 font-mono">
                  <span>Bidder: <strong className="text-slate-200">{truncatePubkey((showcaseBid as Bid).pubkey)}</strong></span>
                  <span>·</span>
                  <span>Relay: <strong className="text-slate-200">{(showcaseBid as Bid).relayUrl.replace('wss://', '')}</strong></span>
                  <span>·</span>
                  <span>Time: <strong className="text-slate-200">{new Date((showcaseBid as Bid).createdAt * 1000).toLocaleTimeString()}</strong></span>
                </div>
              </div>

              <div className="shrink-0">
                <a
                  href={`https://njump.me/${(showcaseBid as Bid).id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors border border-slate-700 flex items-center gap-1.5"
                >
                  Inspect Note <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 bg-slate-950/40 rounded-xl border border-slate-800/60">
              <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3 opacity-80" />
              <p className="text-sm font-medium text-slate-300">No valid bids received yet at or above {startingBidNum.toLocaleString()} sats.</p>
              <p className="text-xs text-slate-400 mt-1 font-mono">Waiting for relay replies or use the tester panel to simulate bids.</p>
              <button
                onClick={() => injectSimulatedBid(275000, "Satoshi")}
                disabled={liveCloseLockedRef.current}
                className="mt-4 px-4 py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-lg"
              >
                Simulate First Bid (275,000 sats)
              </button>
            </div>
          )}
        </section>

        {/* Bid Leaderboard & Relay Status Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          
          {/* Left 2 Cols: Bids Ranked by Amount */}
          <section id="live-feed" className="lg:col-span-2 rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 md:p-8 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-amber-400">
                  <Radio className="w-4 h-4 animate-pulse" />
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">Relay Bids (Sorted by Amount)</h2>
              </div>
              <span className="text-xs font-mono text-slate-400 bg-slate-800 px-3 py-1 rounded-full">
                {sortedBids.length} Total Bids
              </span>
            </div>

            {sortedBids.length > 0 ? (
              <div className="space-y-3 md:max-h-[500px] md:overflow-y-auto md:pr-2">
                {sortedBids.map((bid) => {
                  const isAfterCutoff = closingBlockTimestamp !== null && bid.createdAt > closingBlockTimestamp;
                  const isValid = bid.amountSats >= startingBidNum && !isAfterCutoff;
                  const isHighest = displayedWinner && displayedWinner.id === bid.id;
                  return (
                    <div 
                      key={bid.id}
                      className={`p-4 rounded-xl border transition-all ${
                        isHighest 
                          ? 'bg-amber-500/10 border-amber-500/40 shadow-lg shadow-amber-500/5' 
                          : isValid 
                            ? 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700' 
                            : 'bg-slate-950/30 border-slate-900 opacity-60'
                      }`}
                    >
<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
  <div className="flex flex-wrap items-center gap-2 min-w-0">
    <span className="font-mono text-xs text-amber-400 font-semibold">{truncatePubkey(bid.pubkey)}</span>
    <span className="text-slate-600">·</span>
    <span className="font-mono text-xs text-slate-400">{new Date(bid.createdAt * 1000).toLocaleTimeString()}</span>
  </div>
  <div className="flex flex-wrap items-center gap-2 shrink-0">
    {isHighest && (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-400 text-slate-950 uppercase tracking-wider">
        Highest
      </span>
    )}
    {isAfterCutoff && (
      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 uppercase tracking-wider">
        Post-Block
      </span>
    )}
    <span className={`font-mono text-sm font-bold tabular-nums ${isValid ? 'text-white' : 'text-slate-400'}`}>
      {bid.amountSats.toLocaleString()} sats
    </span>
  </div>
</div>
<p className="text-sm text-slate-300 font-mono break-words">
  {bid.content}
</p>
<div className="flex flex-wrap items-center justify-between gap-2 mt-3 pt-2 border-t border-slate-800/50 text-[11px] font-mono text-slate-400">
  <span className="break-all">Relay: {bid.relayUrl.replace('wss://', '')}</span>
  <a href={`https://njump.me/${bid.id}`} target="_blank" rel="noopener noreferrer" className="hover:text-amber-400 transition-colors flex items-center gap-1 shrink-0">
    Note ID: {bid.id.substring(0, 8)}... <ExternalLink className="w-3 h-3" />
  </a>
</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-16 bg-slate-950/40 rounded-xl border border-slate-800/60">
                <Radio className="w-8 h-8 text-slate-600 mx-auto mb-3 animate-spin" />
                <p className="text-sm text-slate-400">Listening to relay websockets for incoming bids...</p>
              </div>
            )}
          </section>

          {/* Right Col: Relay Connections Health */}
          <section id="relays" className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-white tracking-tight uppercase font-mono">Connected Relays</h2>
              <span className="text-xs font-mono text-slate-400">{connectedRelays.length}/{relaysStatus.length} Online</span>
            </div>

            <div className="space-y-3 mb-6">
              {relaysStatus.map(relay => (
                <div key={relay.url} className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 flex items-center justify-between">
                  <div className="flex items-center gap-2.5 truncate">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${relay.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
                    <span className="text-xs font-mono text-slate-300 truncate">{relay.url.replace('wss://', '')}</span>
                  </div>
                  <span className={`text-[11px] font-mono shrink-0 ml-2 ${relay.connected ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {relay.connected ? 'Online' : 'Offline'}
                  </span>
                </div>
              ))}
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-xl">
              <h3 className="text-xs font-bold text-amber-400 font-mono mb-1 uppercase">Testing Guide</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                You can inject test bids or customize the auction parameters at any time using the configuration panel.
              </p>
              <button
                onClick={() => setShowTesterModal(true)}
                disabled={auctionFinalized && wasLiveBeforeClose}
                className="mt-3 w-full py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-md"
              >
                Open Testing Panel
              </button>
            </div>
          </section>

        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-900/40 py-6 px-6 text-center text-xs text-slate-400 font-mono">
        <p>NostrAuction Nostr Auction Terminal · Powered by Decentralized Relays & Bitcoin Block Height Verification</p>
      </footer>

      {/* Configuration & Tester Modal */}
      {showTesterModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative animate-fade-in">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-amber-400" /> Configure & Test Auction
              </h3>
              <button 
                onClick={() => setShowTesterModal(false)}
                className="text-slate-400 hover:text-white font-mono text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              {/* Live-Witness Warning */}
              <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                  <span>⚠</span>
                  <span>IMPORTANT: KEEP THIS AUCTION TAB OPEN</span>
                </div>
                <p className="text-xs text-amber-100/90 leading-relaxed">
                  To enable Live-Witnessed finalization, open this auction before its closing block is mined and keep this tab open, pinned, and connected to Mempool until the auction closes.
                </p>
                <ul className="list-disc pl-5 space-y-1 text-xs text-amber-100/90 leading-relaxed">
                  <li>Do not close, refresh, or navigate away from this tab.</li>
                  <li>Keep your browser running and your device awake.</li>
                  <li>Keep an eye on the Mempool WS connection status.</li>
                </ul>
                <p className="text-xs text-amber-200 font-semibold leading-relaxed">
                  If you open or reload the auction after its closing block has been mined, the auction cannot be Live-Witnessed. The winner may display with a Not Live-Witnessed caveat.
                </p>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Auction Event (nevent / note1 / ID)</label>
                <input
                  type="text"
                  value={neventInput}
                  onChange={e => setNeventInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                {!showAnchorField && !anchorInput.trim() ? (
                  <button
                    type="button"
                    onClick={() => setShowAnchorField(true)}
                    className="text-xs font-mono text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  >
                    + Also track another note
                  </button>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-mono text-slate-300">Also Track Another Note (Optional)</label>
                      <button
                        type="button"
                        onClick={() => {
                          setAnchorInput('');
                          setShowAnchorField(false);
                        }}
                        className="text-[11px] font-mono text-slate-400 hover:text-slate-200 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                    <input
                      type="text"
                      value={anchorInput}
                      onChange={e => setAnchorInput(e.target.value)}
                      placeholder="Paste another nevent, note1, or event ID"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">Starting Bid (sats)</label>
                  <input
                    type="number"
                    min={0}
                    value={startingBidInput}
                    onChange={e => setStartingBidInput(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">Closing Block Height</label>
                  <input
                    type="number"
                    min={0}
                    value={targetBlockInput}
                    onChange={e => setTargetBlockInput(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              {/* Quick Test Case Loader */}
              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80">
                <span className="text-xs font-mono text-amber-400 block mb-2 font-semibold">⚡ Load User Test Case</span>
                <button
                  onClick={() => {
                    setNeventInput(DEFAULT_TEST_NEVENT);
                    setAnchorInput('');
                    setShowAnchorField(false);
                    setStartingBidInput(String(DEFAULT_STARTING_BID));
                    setTargetBlockInput(String(DEFAULT_TARGET_BLOCK));
                    setShowTesterModal(false);
                  }}
                  className="w-full py-2 px-3 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-mono rounded-lg border border-amber-500/30 transition-colors text-left flex items-center justify-between"
                >
                  <span>Test Event #{DEFAULT_TARGET_BLOCK} ({DEFAULT_STARTING_BID.toLocaleString()} sats)</span>
                  <span className="text-amber-400">Load →</span>
                </button>
              </div>

              {/* Simulate Incoming Bids */}
              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80">
                <span className="text-xs font-mono text-slate-300 block mb-2 font-semibold">Simulate Incoming Relay Bid</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      injectSimulatedBid(320000, "CyberSatoshi");
                    }}
                    disabled={liveCloseLockedRef.current}
                    className="py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg transition-colors text-center"
                  >
                    Bid 320,000 sats
                  </button>
                  <button
                    onClick={() => {
                      injectSimulatedBid(400000, "LightningWhale");
                    }}
                    disabled={liveCloseLockedRef.current}
                    className="py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg transition-colors text-center"
                  >
                    Bid 400,000 sats
                  </button>
                </div>
              </div>

            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-800">
              <button
                onClick={() => setShowTesterModal(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setShowTesterModal(false);
                  const url = new URL(window.location.href);
                  url.searchParams.set('nevent', neventInput);
                  if (anchorInput.trim()) {
                    url.searchParams.set('anchor', anchorInput.trim());
                  } else {
                    url.searchParams.delete('anchor');
                  }
                  url.searchParams.set('start', startingBidInput);
                  url.searchParams.set('block', targetBlockInput);
                  window.history.pushState({}, '', url.toString());
                }}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-xl transition-colors shadow-lg"
              >
                Apply & Update Nsite
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
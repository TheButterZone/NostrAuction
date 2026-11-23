/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Zap, Radio, Terminal, Clock, Award, 
  ExternalLink, Copy, Check, RefreshCw, AlertCircle, 
  Settings2, CheckCircle2
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
  messageCount: number;
  error?: string;
}

const DEFAULT_TEST_NEVENT = "nevent1qgspnzhy9x60m7m66rg9c6rhcwev0k66ahllj72xst799l2sar8wy7sqyz00g9htar9cly8nu9pag5ydrnjtvf0lra7qar4ts4jauyyuh0cavmdttpz";
const DEFAULT_STARTING_BID = 250000;
const DEFAULT_TARGET_BLOCK = 977136;
const BLOCK_POLL_INTERVAL_MS = 60000; // every 60s
const MAX_DYNAMIC_WALK_TARGETS = 100;

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://bitcoiner.social",
  "wss://relay.ditto.pub",
  "wss://relay.dreamith.to",
];

function extractEventRefTags(ev: any): string[] {
  const refs: string[] = [];
  if (ev && Array.isArray(ev.tags)) {
    for (const tag of ev.tags) {
      if ((tag[0] === 'e' || tag[0] === 'E') && tag[1]) {
        refs.push(tag[1]);
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
        id: decoded.data.id,
        relays: decoded.data.relays || [],
        author: decoded.data.author || '',
      };
    }
  } else if (trimmed.startsWith('note1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'note') {
      return { id: decoded.data, relays: [], author: '' };
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
  const [isLiveBlockFetching, setIsLiveBlockFetching] = useState<boolean>(true);
  const [blockFetchError, setBlockFetchError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // Bids state
  const [bids, setBids] = useState<Bid[]>([]);
  const [relaysStatus, setRelaysStatus] = useState<RelayStatus[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [showTesterModal, setShowTesterModal] = useState<boolean>(false);
  const [winnerNotified, setWinnerNotified] = useState<boolean>(false);

  // WebSocket references
  const wsRefs = useRef<{ [url: string]: WebSocket }>({});

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
        messageCount: 0
      })));
    } catch (err) {
      console.error("Failed to decode nevent:", err);
      setDecodedEventId(neventInput);
      setAnchorEventId('');
      setDecodedRelays(DEFAULT_RELAYS);
      setRelaysStatus(DEFAULT_RELAYS.map(url => ({ url, connected: false, messageCount: 0 })));
    }
  }, [neventInput, anchorInput]);

  const targetBlockNum = parseNonNegativeInt(targetBlockInput, DEFAULT_TARGET_BLOCK);
  const startingBidNum = parseNonNegativeInt(startingBidInput, DEFAULT_STARTING_BID);

  // Reset winner notification if auction parameters change
  useEffect(() => {
    setWinnerNotified(false);
  }, [decodedEventId, anchorEventId, startingBidNum, targetBlockNum]);

  // Fetch live bitcoin block height & target block timestamp from mempool.space API
  const fetchBlockHeight = useCallback(async () => {
    setIsLiveBlockFetching(true);
    try {
      const res = await fetch('https://mempool.space/api/blocks/tip/height', { cache: 'no-store' });
      if (!res.ok) throw new Error("Failed to fetch block height");
      const heightText = await res.text();
      const height = parseInt(heightText.trim(), 10);
      if (!isNaN(height) && height > 0) {
        setCurrentBlockHeight(height);
        setLastSyncedAt(Math.floor(Date.now() / 1000));
        setBlockFetchError(null);

        if (height >= targetBlockNum) {
          try {
            const hashRes = await fetch(`https://mempool.space/api/block-height/${targetBlockNum}`, { cache: 'no-store' });
            if (hashRes.ok) {
              const blockHash = (await hashRes.text()).trim();
              const blockRes = await fetch(`https://mempool.space/api/block/${blockHash}`, { cache: 'no-store' });
              if (blockRes.ok) {
                const blockData = await blockRes.json();
                if (typeof blockData.timestamp === 'number') {
                  setClosingBlockTimestamp(blockData.timestamp);
                }
              }
            }
          } catch (tsErr) {
            console.warn("Failed to fetch closing block timestamp:", tsErr);
          }
        } else {
          setClosingBlockTimestamp(null);
        }
      }
    } catch (err) {
      console.warn("Mempool API fetch error:", err);
      setBlockFetchError("Mempool API unreachable");
    } finally {
      setIsLiveBlockFetching(false);
    }
  }, [targetBlockNum]);

  useEffect(() => {
    fetchBlockHeight();
    const interval = setInterval(fetchBlockHeight, BLOCK_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchBlockHeight]);

  const auctionClosed = currentBlockHeight !== null && currentBlockHeight >= targetBlockNum;

  // Highest bid calculation (enforcing starting bid & closing block timestamp cutoff when mined)
  const validBids = bids.filter(b => {
    if (b.amountSats < startingBidNum) return false;
    if (closingBlockTimestamp !== null && b.createdAt > closingBlockTimestamp) return false;
    return true;
  });

  const highestBid = validBids.length > 0 
    ? validBids.reduce((max, b) => {
        if (b.amountSats !== max.amountSats) {
          return b.amountSats > max.amountSats ? b : max;
        }
        // Earlier timestamp wins ties
        return b.createdAt < max.createdAt ? b : max;
      }, validBids[0])
    : null;

  // Check if auction closed and trigger winner notification
  useEffect(() => {
    if (auctionClosed && highestBid && !winnerNotified) {
      setWinnerNotified(true);
    }
  }, [auctionClosed, highestBid, winnerNotified]);

  // Connect to Relays WebSocket with root anchoring, active parent fetching, and bidirectional e/E-tag walking
  useEffect(() => {
    if (!decodedEventId || decodedRelays.length === 0) return;

    setIsListening(true);
    setBids([]);
    const newWsRefs: { [url: string]: WebSocket } = {};

    const rootEventIds = Array.from(
      new Set([decodedEventId, anchorEventId].filter(Boolean))
    );

    const discoveredEventIds = new Set<string>(rootEventIds);
    const queriedIds = new Set<string>(rootEventIds);
    const seenBidIds = new Set<string>();
    const pendingByParentId = new Map<string, Array<{ ev: any; relayUrl: string }>>();

    const queryTargetAcrossSockets = (targetId: string) => {
      if (!targetId || queriedIds.has(targetId)) return;
      if (queriedIds.size >= MAX_DYNAMIC_WALK_TARGETS) return;
      queriedIds.add(targetId);

      Object.values(newWsRefs).forEach(sock => {
        if (sock.readyState === WebSocket.OPEN) {
          const suffix = `${targetId.substring(0, 8)}_${Math.random().toString(36).substring(7)}`;
          const subE = `auction_bidir_e_${suffix}`;
          const subUpperE = `auction_bidir_E_${suffix}`;
          const subId = `auction_id_${suffix}`;

          sock.send(JSON.stringify(["REQ", subE, { kinds: [1, 1111], '#e': [targetId], limit: 200 }]));
          sock.send(JSON.stringify(["REQ", subUpperE, { kinds: [1, 1111], '#E': [targetId], limit: 200 }]));
          sock.send(JSON.stringify(["REQ", subId, { kinds: [1, 1111], ids: [targetId], limit: 50 }]));

          setTimeout(() => {
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify(["CLOSE", subE]));
              sock.send(JSON.stringify(["CLOSE", subUpperE]));
              sock.send(JSON.stringify(["CLOSE", subId]));
            }
          }, 8000);
        }
      });
    };

    const acceptThreadEvent = (ev: any, eventRefTags: string[], relayUrl: string) => {
      parseAndAddBid(ev, relayUrl, seenBidIds);

      const newlyDiscovered = !discoveredEventIds.has(ev.id);
      discoveredEventIds.add(ev.id);

      // Walk both the event's own ID (for child replies) and all its e/E references (for parent/root events)
      const idsToWalk = [ev.id, ...eventRefTags];
      idsToWalk.forEach(targetId => {
        if (!discoveredEventIds.has(targetId)) {
          discoveredEventIds.add(targetId);
        }
        queryTargetAcrossSockets(targetId);
      });

      // Flush any out-of-order children waiting on this event ID
      if (newlyDiscovered && pendingByParentId.has(ev.id)) {
        const queued = pendingByParentId.get(ev.id) || [];
        pendingByParentId.delete(ev.id);
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
          setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, connected: true, error: undefined } : r));

          const allKnownIds = Array.from(discoveredEventIds);

          // 1. Subscribe to #e, #E, and direct ids for all known root/discovered thread events
          const subRootLowerId = `auction_roots_e_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subRootLowerId, { kinds: [1, 1111], '#e': allKnownIds, limit: 500 }]));

          const subRootUpperId = `auction_roots_E_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subRootUpperId, { kinds: [1, 1111], '#E': allKnownIds, limit: 500 }]));

          const subRootIdsId = `auction_roots_ids_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subRootIdsId, { kinds: [1, 1111], ids: allKnownIds, limit: 200 }]));

          // 2. Author notes query if authorPubkey is known
          if (authorPubkey) {
            const subAuthorId = `auction_author_${Math.random().toString(36).substring(7)}`;
            ws.send(JSON.stringify(["REQ", subAuthorId, { kinds: [1, 1111], authors: [authorPubkey], limit: 200 }]));
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (Array.isArray(data) && data[0] === 'EVENT' && data[2]) {
              const ev = data[2];
              const eventRefTags = extractEventRefTags(ev);

              // Check if event belongs to thread graph (is a root/discovered ID or tags any root/discovered ID)
              let belongsToThread =
                discoveredEventIds.has(ev.id) ||
                eventRefTags.some(refTag => discoveredEventIds.has(refTag));

              if (belongsToThread) {
                acceptThreadEvent(ev, eventRefTags, relayUrl);
              } else if (eventRefTags.length > 0 && !seenBidIds.has(ev.id)) {
                // Queue until one of its referenced parent/thread events arrives, and actively query those parent IDs
                for (const refTag of eventRefTags) {
                  const list = pendingByParentId.get(refTag) || [];
                  if (!list.some(item => item.ev.id === ev.id)) {
                    list.push({ ev, relayUrl });
                    pendingByParentId.set(refTag, list);
                  }
                  queryTargetAcrossSockets(refTag);
                }
              }

              setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, messageCount: r.messageCount + 1 } : r));
            }
          } catch (e) {
            console.error("Error parsing WS message from", relayUrl, e);
          }
        };

        ws.onerror = (err) => {
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

    wsRefs.current = newWsRefs;

    return () => {
      Object.values(wsRefs.current).forEach(ws => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      });
    };
  }, [decodedEventId, anchorEventId, decodedRelays, authorPubkey]);

  // Parse Nostr event content to extract bid amounts in satoshis across nested threads
  const parseAndAddBid = (ev: any, relayUrl: string, seenSet?: Set<string>) => {
    if (!ev || !ev.content || !ev.id || !ev.pubkey) return;
    if (seenSet && seenSet.has(ev.id)) return;
    if (seenSet) seenSet.add(ev.id);

    const content = ev.content;
    const amount = extractSatsFromText(content);

    if (amount && amount > 0) {
      const newBid: Bid = {
        id: ev.id,
        pubkey: ev.pubkey,
        content: content,
        amountSats: amount,
        createdAt: ev.created_at || Math.floor(Date.now() / 1000),
        relayUrl: relayUrl
      };

      setBids(prev => {
        if (prev.some(b => b.id === newBid.id)) return prev;
        return [newBid, ...prev];
      });
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

    // 3. Explicit "k" thousands shorthand (e.g. "650k", "1.25k", "50k")
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

    setBids(prev => [simulatedBid, ...prev]);
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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500/30 selection:text-amber-200">
      
      {/* Top Bar Contract (1 row, 3 zones, gap-8) */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800/80 bg-slate-900/55 backdrop-blur-md sticky top-0 z-50">
        
        {/* Zone 1: Single text element wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 font-bold">
            ⚡
          </div>
          <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap">
            NostrAuction <span className="text-amber-400 font-mono text-xs ml-1 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">AUCTION TERMINAL</span>
          </span>
        </div>

        {/* Zone 2: 4-5 clean single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a href="#auction-hero" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Auction Details</a>
          <a href="#highest-bidder" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Highest Bid</a>
          <a href="#live-feed" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Relay Feed</a>
          <a href="#relays" className="hover:text-amber-400 transition-colors whitespace-nowrap shrink-0">Relays</a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button 
            onClick={() => setShowTesterModal(true)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors shadow-lg shadow-amber-400/10 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Configure Auction
          </button>
        </div>

      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-8">

        {/* Winner / Auction Closed Notification Banner */}
        {auctionClosed && highestBid && (
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
                    Winning Bid Confirmed: {highestBid.amountSats.toLocaleString()} sats ({formatBtc(highestBid.amountSats)})
                  </h2>
                  <p className="text-sm text-slate-300 mt-1">
                    Winner Npub: <span className="font-mono text-amber-300">{truncatePubkey(highestBid.pubkey)}</span> · Event ID: <span className="font-mono text-slate-400 text-xs">{highestBid.id.substring(0, 16)}...</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <a 
                  href={`https://njump.me/${highestBid.id}`} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition-colors shadow-lg shadow-emerald-600/20 whitespace-nowrap"
                >
                  View Winning Note on Njump <ExternalLink className="w-3.5 h-3.5" />
                </a>
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
                  <span>·</span>
                  <span className="text-amber-400">RELAY STREAM ACTIVE</span>
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
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                    LIVE MEMPOOL
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
                  <span>Source</span>
                  <a
                    href="https://mempool.space/api/blocks/tip/height"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-amber-400 hover:underline"
                  >
                    mempool.space API
                  </a>
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
                {closingBlockTimestamp !== null && (
                  <div className="flex justify-between">
                    <span>Cutoff UTC</span>
                    <span className="text-slate-200 tabular-nums">
                      {new Date(closingBlockTimestamp * 1000).toISOString().replace('T', ' ').substring(0, 19)}Z
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="text-[11px] text-slate-400 font-mono pt-4 border-t border-slate-800/60 text-center">
              Mempool API: {isLiveBlockFetching ? 'Syncing...' : (blockFetchError || 'Connected ⚡')}
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
            <span className="text-xs font-mono text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/20">
              REAL-TIME RELAY LEADER
            </span>
          </div>

          {highestBid ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
              <div className="md:col-span-2 space-y-3">
                <div className="text-3xl sm:text-4xl font-bold font-mono text-amber-400 tabular-nums tracking-tight">
                  {highestBid.amountSats.toLocaleString()} <span className="text-lg font-normal text-slate-300">sats</span>
                  <span className="text-sm font-normal text-slate-400 ml-3">({formatBtc(highestBid.amountSats)})</span>
                </div>
                <p className="text-sm text-slate-300 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 italic font-mono">
                  "{highestBid.content}"
                </p>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 font-mono">
                  <span>Bidder: <strong className="text-slate-200">{truncatePubkey(highestBid.pubkey)}</strong></span>
                  <span>·</span>
                  <span>Relay: <strong className="text-slate-200">{highestBid.relayUrl.replace('wss://', '')}</strong></span>
                  <span>·</span>
                  <span>Time: <strong className="text-slate-200">{new Date(highestBid.createdAt * 1000).toLocaleTimeString()}</strong></span>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center bg-slate-950/60 p-6 rounded-xl border border-slate-800/80 text-center">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
                  <Award className="w-6 h-6" />
                </div>
                <span className="text-xs font-mono text-slate-400 uppercase">Leading Status</span>
                <span className="text-sm font-bold text-emerald-400 mt-1">Valid & Verified</span>
                <a
                  href={`https://njump.me/${highestBid.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors border border-slate-700 flex items-center gap-1.5"
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
                className="mt-4 px-4 py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors shadow-lg"
              >
                Simulate First Bid (275,000 sats)
              </button>
            </div>
          )}
        </section>

        {/* Live Bid Stream & Relay Status Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          
          {/* Left 2 Cols: Live Bid Stream */}
          <section id="live-feed" className="lg:col-span-2 rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 md:p-8 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-amber-400">
                  <Radio className="w-4 h-4 animate-pulse" />
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">Live Relay Bid Feed</h2>
              </div>
              <span className="text-xs font-mono text-slate-400 bg-slate-800 px-3 py-1 rounded-full">
                {bids.length} Total Replies
              </span>
            </div>

            {bids.length > 0 ? (
              <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                {[...bids].sort((a, b) => {
                  const aExpired = closingBlockTimestamp !== null && a.createdAt > closingBlockTimestamp;
                  const bExpired = closingBlockTimestamp !== null && b.createdAt > closingBlockTimestamp;
                  const aValid = a.amountSats >= startingBidNum && !aExpired;
                  const bValid = b.amountSats >= startingBidNum && !bExpired;
                  if (aValid && !bValid) return -1;
                  if (!aValid && bValid) return 1;
                  return b.amountSats - a.amountSats;
                }).map((bid, index) => {
                  const isAfterCutoff = closingBlockTimestamp !== null && bid.createdAt > closingBlockTimestamp;
                  const isValid = bid.amountSats >= startingBidNum && !isAfterCutoff;
                  const isHighest = highestBid && highestBid.id === bid.id;
                  return (
                    <div 
                      key={bid.id + index}
                      className={`p-4 rounded-xl border transition-all ${
                        isHighest 
                          ? 'bg-amber-500/10 border-amber-500/40 shadow-lg shadow-amber-500/5' 
                          : isValid 
                            ? 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700' 
                            : 'bg-slate-950/30 border-slate-900 opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-amber-400 font-semibold">{truncatePubkey(bid.pubkey)}</span>
                          <span className="text-slate-600">·</span>
                          <span className="font-mono text-xs text-slate-400">{new Date(bid.createdAt * 1000).toLocaleTimeString()}</span>
                        </div>
                        <div className="flex items-center gap-2">
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
                      <p className="text-sm text-slate-300 font-mono">
                        {bid.content}
                      </p>
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800/50 text-[11px] font-mono text-slate-400">
                        <span>Relay: {bid.relayUrl.replace('wss://', '')}</span>
                        <a href={`https://njump.me/${bid.id}`} target="_blank" rel="noopener noreferrer" className="hover:text-amber-400 transition-colors flex items-center gap-1">
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
              <span className="text-xs font-mono text-slate-400">{relaysStatus.filter(r => r.connected).length}/{relaysStatus.length} Online</span>
            </div>

            <div className="space-y-3 mb-6">
              {relaysStatus.map(relay => (
                <div key={relay.url} className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 flex items-center justify-between">
                  <div className="flex items-center gap-2.5 truncate">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${relay.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
                    <span className="text-xs font-mono text-slate-300 truncate">{relay.url.replace('wss://', '')}</span>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400 shrink-0 ml-2">
                    {relay.messageCount} msgs
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
                className="mt-3 w-full py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors shadow-md"
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
                <label className="block text-xs font-mono text-slate-300 mb-1">Optional Thread Anchor (nevent / note1 / ID)</label>
                <input
                  type="text"
                  value={anchorInput}
                  onChange={e => setAnchorInput(e.target.value)}
                  placeholder="Leave blank unless anchoring a secondary thread event"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                />
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
                    className="py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg transition-colors text-center"
                  >
                    Bid 320,000 sats
                  </button>
                  <button
                    onClick={() => {
                      injectSimulatedBid(400000, "LightningWhale");
                    }}
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
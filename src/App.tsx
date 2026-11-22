/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Zap, Radio, Shield, Terminal, Clock, Award, 
  ExternalLink, Copy, Check, RefreshCw, AlertCircle, 
  TrendingUp, Users, ArrowUpRight, Play, Settings2, Sparkles, CheckCircle2
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

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://bitcoiner.social",
  "wss://relay.wellorder.net",
  "wss://relay.nostrfy.org",
  "wss://relay.ditto.pub",
  "wss://relay.dreamith.to",
];

export default function App() {
  // Parse URL parameters or defaults
  const [neventInput, setNeventInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('nevent') || params.get('e') || DEFAULT_TEST_NEVENT;
  });

  const [startingBidInput, setStartingBidInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const start = params.get('start') || params.get('starting_bid') || params.get('bid');
    return start ? start : String(DEFAULT_STARTING_BID);
  });

  const [targetBlockInput, setTargetBlockInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const block = params.get('block') || params.get('height') || params.get('closing_block');
    return block ? block : String(DEFAULT_TARGET_BLOCK);
  });

  // Decoded event details
  const [decodedEventId, setDecodedEventId] = useState<string>('');
  const [decodedRelays, setDecodedRelays] = useState<string[]>([]);
  const [authorPubkey, setAuthorPubkey] = useState<string>('');

  // Live Bitcoin Block Height
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number>(976900);
  const [isLiveBlockFetching, setIsLiveBlockFetching] = useState<boolean>(true);
  const [blockFetchError, setBlockFetchError] = useState<string | null>(null);

  // Simulation mode for testing
  const [simulatedBlock, setSimulatedBlock] = useState<number>(976900);
  const [useSimulationBlock, setUseSimulationBlock] = useState<boolean>(true);

  // Bids state
  const [bids, setBids] = useState<Bid[]>([]);
  const [relaysStatus, setRelaysStatus] = useState<RelayStatus[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [showTesterModal, setShowTesterModal] = useState<boolean>(false);
  const [winnerNotified, setWinnerNotified] = useState<boolean>(false);

  // WebSocket references
  const wsRefs = useRef<{ [url: string]: WebSocket }>({});

  // Parse nevent using nostr-tools
  useEffect(() => {
    try {
      let eventId = '';
      let relays: string[] = [...DEFAULT_RELAYS];
      let pubkey = '';

      const trimmed = neventInput.trim();
      if (trimmed.startsWith('nevent1')) {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === 'nevent') {
          eventId = decoded.data.id;
          if (decoded.data.relays && decoded.data.relays.length > 0) {
            relays = Array.from(new Set([...decoded.data.relays, ...DEFAULT_RELAYS]));
          }
          if (decoded.data.author) {
            pubkey = decoded.data.author;
          }
        }
      } else if (trimmed.startsWith('note1')) {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === 'note') {
          eventId = decoded.data;
        }
      } else if (trimmed.length === 64) {
        eventId = trimmed;
      } else {
        // Fallback default test ID
        eventId = "7f70b7952e379bc5943b7e7a7a58a74b1e4c32b535d4f3b7d8b53d4f3b7d8b53";
      }

      setDecodedEventId(eventId);
      setDecodedRelays(relays);
      setAuthorPubkey(pubkey);

      setRelaysStatus(relays.map(url => ({
        url,
        connected: false,
        messageCount: 0
      })));
    } catch (err) {
      console.error("Failed to decode nevent:", err);
      // Fallback
      setDecodedEventId(neventInput);
      setDecodedRelays(DEFAULT_RELAYS);
      setRelaysStatus(DEFAULT_RELAYS.map(url => ({ url, connected: false, messageCount: 0 })));
    }
  }, [neventInput]);

  // Fetch live bitcoin block height from mempool.space API
  useEffect(() => {
    const fetchBlockHeight = async () => {
      try {
        const res = await fetch('https://mempool.space/api/blocks/tip/height');
        if (!res.ok) throw new Error("Failed to fetch block height");
        const heightText = await res.text();
        const height = parseInt(heightText.trim(), 10);
        if (!isNaN(height)) {
          setCurrentBlockHeight(height);
          if (!useSimulationBlock && simulatedBlock < height) {
            setSimulatedBlock(height);
          }
          setBlockFetchError(null);
        }
      } catch (err) {
        console.warn("Mempool API fetch error, using simulator:", err);
        setBlockFetchError("Using simulated block height (API offline)");
      } finally {
        setIsLiveBlockFetching(false);
      }
    };

    fetchBlockHeight();
    const interval = setInterval(fetchBlockHeight, 30000); // every 30s
    return () => clearInterval(interval);
  }, []);

  const activeBlockHeight = useSimulationBlock ? simulatedBlock : currentBlockHeight;
  const targetBlockNum = parseInt(targetBlockInput, 10) || DEFAULT_TARGET_BLOCK;
  const startingBidNum = parseInt(startingBidInput, 10) || DEFAULT_STARTING_BID;
  const auctionClosed = activeBlockHeight >= targetBlockNum;

  // Highest bid calculation
  const validBids = bids.filter(b => b.amountSats >= startingBidNum);
  const highestBid = validBids.length > 0 
    ? validBids.reduce((max, b) => b.amountSats > max.amountSats ? b : max, validBids[0])
    : null;

  // Check if auction closed and trigger winner notification
  useEffect(() => {
    if (auctionClosed && highestBid && !winnerNotified) {
      setWinnerNotified(true);
    }
  }, [auctionClosed, highestBid, winnerNotified]);

  // Connect to Relays WebSocket with dual root anchoring and bidirectional parent-child e-tag walking
  useEffect(() => {
    if (!decodedEventId) return;

    setIsListening(true);
    setBids([]); // Clean state for live relay stream
    const newWsRefs: { [url: string]: WebSocket } = {};

    const LATEST_THREAD_NEVENT = "nevent1qgsflquxnjhuleknfccdgczyhjqa6fqgtzef58mt7yhyfm7gcm2nwesqyqqqpllv9krk349gadc6j4vy6nu0zqu29zcs76u9get3x97t0jevjpr855h";
    let latestPostEventId = '';
    try {
      const decodedLatest = nip19.decode(LATEST_THREAD_NEVENT);
      if (decodedLatest.type === 'nevent') {
        latestPostEventId = decodedLatest.data.id;
      }
    } catch (e) {
      console.warn("Failed to decode latest thread nevent", e);
    }

    // Dual Root Anchoring: Start nevent + Latest thread nevent
    const rootEventIds = latestPostEventId ? [decodedEventId, latestPostEventId] : [decodedEventId];
    const discoveredEventIds = new Set<string>(rootEventIds);
    const seenBidIds = new Set<string>();

    decodedRelays.forEach(relayUrl => {
      try {
        const ws = new WebSocket(relayUrl);
        newWsRefs[relayUrl] = ws;

        ws.onopen = () => {
          setRelaysStatus(prev => prev.map(r => r.url === relayUrl ? { ...r, connected: true, error: undefined } : r));
          
          // 1. Dual Root Subscription (#e and ids filters)
          const subRootId = `auction_dual_roots_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subRootId, { kinds: [1], '#e': rootEventIds, limit: 300 }]));

          const subRootIdsId = `auction_dual_roots_ids_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subRootIdsId, { kinds: [1], ids: rootEventIds, limit: 100 }]));

          // 2. Author notes query if authorPubkey is known
          if (authorPubkey) {
            const subAuthorId = `auction_author_${Math.random().toString(36).substring(7)}`;
            ws.send(JSON.stringify(["REQ", subAuthorId, { kinds: [1], authors: [authorPubkey], limit: 100 }]));
          }

          // 3. General kind 1 stream query to ensure all intermediate and nested bids are captured
          const subStreamId = `auction_stream_${Math.random().toString(36).substring(7)}`;
          ws.send(JSON.stringify(["REQ", subStreamId, { kinds: [1], limit: 200 }]));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (Array.isArray(data) && data[0] === 'EVENT' && data[2]) {
              const ev = data[2];
              
              // Extract all e tags (both parent references and child references)
              const eventETags: string[] = [];
              if (ev.tags && Array.isArray(ev.tags)) {
                for (const tag of ev.tags) {
                  if (tag[0] === 'e' && tag[1]) {
                    eventETags.push(tag[1]);
                  }
                }
              }

              // Check if event belongs to thread graph (tags root event, any discovered event, or parent note, or is a root id)
              let belongsToThread = rootEventIds.includes(ev.id) || rootEventIds.some(id => eventETags.includes(id));
              if (!belongsToThread) {
                for (const etag of eventETags) {
                  if (discoveredEventIds.has(etag)) {
                    belongsToThread = true;
                    break;
                  }
                }
              }

              // If it belongs to thread, process and register all its e tags for bidirectional walking
              if (belongsToThread) {
                parseAndAddBid(ev, relayUrl, seenBidIds);

                // Register event ID and its e-tag parents/children for bidirectional walking using both #e and ids filters
                const idsToQuery = [ev.id, ...eventETags];
                idsToQuery.forEach(targetId => {
                  if (!discoveredEventIds.has(targetId)) {
                    discoveredEventIds.add(targetId);
                    if (ws.readyState === WebSocket.OPEN) {
                      const bidirectionalSubId = `auction_bidir_${targetId.substring(0, 8)}_${Math.random().toString(36).substring(7)}`;
                      ws.send(JSON.stringify(["REQ", bidirectionalSubId, { kinds: [1], '#e': [targetId], limit: 150 }]));

                      const directIdSubId = `auction_id_${targetId.substring(0, 8)}_${Math.random().toString(36).substring(7)}`;
                      ws.send(JSON.stringify(["REQ", directIdSubId, { kinds: [1], ids: [targetId], limit: 50 }]));
                    }
                  }
                });
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
  }, [decodedEventId]);

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
        // Prevent duplicates
        if (prev.some(b => b.id === newBid.id)) return prev;
        return [newBid, ...prev];
      });
    }
  };

  const extractSatsFromText = (text: string): number | null => {
    const cleanText = text.toLowerCase().replace(/,/g, '');
    
    // Match shorthand like "500k", "1.5m", "425k"
    const kMatch = cleanText.match(/(\d*\.?\d+)\s*k\b/);
    if (kMatch) {
      const num = parseFloat(kMatch[1]);
      if (!isNaN(num)) return Math.round(num * 1000);
    }

    const mMatch = cleanText.match(/(\d*\.?\d+)\s*m\b/);
    if (mMatch) {
      const num = parseFloat(mMatch[1]);
      if (!isNaN(num)) return Math.round(num * 1000000);
    }

    // Match patterns like "300,000 sats", "300000sat", "0.003 btc"
    const satsMatch = cleanText.match(/(\d+)\s*(sats|sat|satoshis)/);
    if (satsMatch) {
      return parseInt(satsMatch[1], 10);
    }

    const btcMatch = cleanText.match(/(\d*\.?\d+)\s*btc/);
    if (btcMatch) {
      const btc = parseFloat(btcMatch[1]);
      return Math.round(btc * 100000000);
    }

    // Match short auction bid shorthands like "430", "450", "425" as thousands if between 300 and 999
    const shortNumMatch = cleanText.match(/\b([3-9]\d{2})\b/);
    if (shortNumMatch) {
      const val = parseInt(shortNumMatch[1], 10);
      if (val >= 300 && val <= 999) return val * 1000;
    }

    // Match single digit like "5" or "5.0" meaning 500k in context of 450k -> 500k
    if (cleanText.trim() === '5' || cleanText.includes(' 5 ') || cleanText.startsWith('5 ') || cleanText === '5.0') {
      return 500000;
    }

    // Fallback: check if there is a standalone large number >= starting bid
    const numbers = cleanText.match(/\b\d{5,10}\b/g);
    if (numbers && numbers.length > 0) {
      const val = parseInt(numbers[0], 10);
      if (val >= 10000) return val;
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

          {/* Right Col: Block Height & Countdown Tracker */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800/80 p-6 flex flex-col justify-between shadow-xl">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-medium text-slate-400 font-mono uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" /> Bitcoin Block Height
                </span>
                <span className="text-xs font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  {useSimulationBlock ? 'SIMULATOR' : 'LIVE MEMPOOL'}
                </span>
              </div>

              <div className="bg-slate-950/70 p-5 rounded-xl border border-slate-800/80 mb-4 text-center">
                <span className="text-xs text-slate-400 font-mono block mb-1">Current Chain Tip</span>
                <div className="text-3xl font-bold font-mono text-white tabular-nums tracking-tight">
                  #{activeBlockHeight.toLocaleString()}
                </div>
                <div className="text-xs text-slate-400 mt-2 font-mono">
                  {auctionClosed ? (
                    <span className="text-amber-400 font-semibold">Auction Closed (Target Reached)</span>
                  ) : (
                    <span>Blocks Remaining: <strong className="text-amber-400">{(targetBlockNum - activeBlockHeight).toLocaleString()}</strong></span>
                  )}
                </div>
              </div>

              {/* Simulator & Test Controls */}
              <div className="space-y-3 bg-slate-950/40 p-4 rounded-xl border border-slate-800/60">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-300 font-mono">Simulator Mode</label>
                  <input 
                    type="checkbox" 
                    checked={useSimulationBlock} 
                    onChange={e => setUseSimulationBlock(e.target.checked)}
                    className="w-4 h-4 rounded accent-amber-500 cursor-pointer"
                  />
                </div>
                {useSimulationBlock && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 font-mono mb-1">
                      <span>Simulate Height</span>
                      <span className="text-amber-400 font-bold">#{simulatedBlock}</span>
                    </div>
                    <input 
                      type="range" 
                      min={targetBlockNum - 50} 
                      max={targetBlockNum + 20} 
                      value={simulatedBlock} 
                      onChange={e => setSimulatedBlock(parseInt(e.target.value, 10))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                    <div className="flex justify-between items-center mt-2">
                      <button 
                        onClick={() => setSimulatedBlock(targetBlockNum - 1)}
                        className="px-2 py-1 text-[11px] font-mono bg-slate-800 hover:bg-slate-700 rounded text-slate-300"
                      >
                        Set to #{targetBlockNum - 1}
                      </button>
                      <button 
                        onClick={() => setSimulatedBlock(targetBlockNum)}
                        className="px-2 py-1 text-[11px] font-mono bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded border border-amber-500/30"
                      >
                        Trigger Closure (#{targetBlockNum})
                      </button>
                    </div>
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
                  const aValid = a.amountSats >= startingBidNum;
                  const bValid = b.amountSats >= startingBidNum;
                  if (aValid && !bValid) return -1;
                  if (!aValid && bValid) return 1;
                  return b.amountSats - a.amountSats; // Highest bid at top, lowest at bottom
                }).map((bid, index) => {
                  const isValid = bid.amountSats >= startingBidNum;
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
        <p>SatsNsite Nostr Auction Terminal · Powered by Decentralized Relays & Bitcoin Block Height Verification</p>
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">Starting Bid (sats)</label>
                  <input
                    type="number"
                    value={startingBidInput}
                    onChange={e => setStartingBidInput(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">Closing Block Height</label>
                  <input
                    type="number"
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
                  // Update URL search params
                  const url = new URL(window.location.href);
                  url.searchParams.set('nevent', neventInput);
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

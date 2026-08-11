
-- 1. coin_registry
CREATE TABLE public.coin_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  symbol text NOT NULL,
  coingecko_id text NOT NULL UNIQUE,
  rank int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.coin_registry TO anon, authenticated;
GRANT ALL ON public.coin_registry TO service_role;
ALTER TABLE public.coin_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coin_registry public read" ON public.coin_registry FOR SELECT USING (true);

CREATE INDEX coin_registry_symbol_lower_idx ON public.coin_registry (lower(symbol));
CREATE INDEX coin_registry_name_lower_idx ON public.coin_registry (lower(name));

INSERT INTO public.coin_registry (name, symbol, coingecko_id, rank) VALUES
('Bitcoin','BTC','bitcoin',1),
('Ethereum','ETH','ethereum',2),
('Tether','USDT','tether',3),
('BNB','BNB','binancecoin',4),
('Solana','SOL','solana',5),
('XRP','XRP','ripple',6),
('USDC','USDC','usd-coin',7),
('Dogecoin','DOGE','dogecoin',8),
('Cardano','ADA','cardano',9),
('TRON','TRX','tron',10),
('Toncoin','TON','the-open-network',11),
('Avalanche','AVAX','avalanche-2',12),
('Shiba Inu','SHIB','shiba-inu',13),
('Chainlink','LINK','chainlink',14),
('Polkadot','DOT','polkadot',15),
('Bitcoin Cash','BCH','bitcoin-cash',16),
('NEAR Protocol','NEAR','near',17),
('Litecoin','LTC','litecoin',18),
('Polygon','MATIC','matic-network',19),
('Uniswap','UNI','uniswap',20),
('Internet Computer','ICP','internet-computer',21),
('Ethereum Classic','ETC','ethereum-classic',22),
('Pepe','PEPE','pepe',23),
('Aptos','APT','aptos',24),
('Kaspa','KAS','kaspa',25),
('Stellar','XLM','stellar',26),
('Monero','XMR','monero',27),
('Cronos','CRO','crypto-com-chain',28),
('OKB','OKB','okb',29),
('Filecoin','FIL','filecoin',30),
('Arbitrum','ARB','arbitrum',31),
('Hedera','HBAR','hedera-hashgraph',32),
('Mantle','MNT','mantle',33),
('Cosmos','ATOM','cosmos',34),
('Stacks','STX','blockstack',35),
('Maker','MKR','maker',36),
('VeChain','VET','vechain',37),
('Immutable','IMX','immutable-x',38),
('Injective','INJ','injective-protocol',39),
('Optimism','OP','optimism',40),
('Render','RNDR','render-token',41),
('Sui','SUI','sui',42),
('Fantom','FTM','fantom',43),
('Lido DAO','LDO','lido-dao',44),
('The Graph','GRT','the-graph',45),
('Bittensor','TAO','bittensor',46),
('Aave','AAVE','aave',47),
('Sei','SEI','sei-network',48),
('Rocket Pool','RPL','rocket-pool',49),
('Algorand','ALGO','algorand',50),
('Bonk','BONK','bonk',51),
('THORChain','RUNE','thorchain',52),
('Flow','FLOW','flow',53),
('Quant','QNT','quant-network',54),
('Fetch.ai','FET','fetch-ai',55),
('Beam','BEAM','beam-2',56),
('MultiversX','EGLD','elrond-erd-2',57),
('Ondo','ONDO','ondo-finance',58),
('KuCoin Token','KCS','kucoin-shares',59),
('Theta Network','THETA','theta-token',60),
('Axie Infinity','AXS','axie-infinity',61),
('Tezos','XTZ','tezos',62),
('Chiliz','CHZ','chiliz',63),
('BitTorrent','BTT','bittorrent',64),
('Neo','NEO','neo',65),
('Astar','ASTR','astar',66),
('Kava','KAVA','kava',67),
('EOS','EOS','eos',68),
('Sats','SATS','sats-ordinals',69),
('IOTA','IOTA','iota',70),
('Klaytn','KLAY','klay-token',71),
('Wormhole','W','wormhole',72),
('WOO Network','WOO','woo-network',73),
('Curve DAO','CRV','curve-dao-token',74),
('BinaryX','BNX','binaryx',75),
('dYdX','DYDX','dydx-chain',76),
('Frax','FRAX','frax',77),
('Blur','BLUR','blur',78),
('Ronin','RON','ronin',79),
('Terra Luna Classic','LUNC','terra-luna',80),
('PancakeSwap','CAKE','pancakeswap-token',81),
('Gala','GALA','gala',82),
('Compound','COMP','compound-governance-token',83),
('Ecash','XEC','ecash',84),
('Zcash','ZEC','zcash',85),
('Pendle','PENDLE','pendle',86),
('Jito','JTO','jito-governance-token',87),
('Wemix','WEMIX','wemix-token',88),
('Nervos Network','CKB','nervos-network',89),
('1inch','1INCH','1inch',90),
('Enjin Coin','ENJ','enjincoin',91),
('Basic Attention Token','BAT','basic-attention-token',92),
('Ravencoin','RVN','ravencoin',93),
('Ordi','ORDI','ordinals',94),
('Dash','DASH','dash',95),
('Convex Finance','CVX','convex-finance',96),
('SafePal','SFP','safepal',97),
('Waves','WAVES','waves',98),
('Zilliqa','ZIL','zilliqa',99),
('Manta Network','MANTA','manta-network',100);

-- 2. market_cache
CREATE TABLE public.market_cache (
  coingecko_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.market_cache TO service_role;
ALTER TABLE public.market_cache ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role can access.

-- 3. FTS on news_chunks
ALTER TABLE public.news_chunks
  ADD COLUMN IF NOT EXISTS chunk_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(article_title,'') || ' ' || coalesce(chunk_text,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS news_chunks_tsv_idx ON public.news_chunks USING gin (chunk_tsv);

-- 4. FTS search RPC
CREATE OR REPLACE FUNCTION public.search_news_fts(query_text text, match_count int DEFAULT 8)
RETURNS TABLE (
  id uuid,
  article_title text,
  article_url text,
  source_name text,
  published_at timestamptz,
  chunk_text text,
  rank real
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    n.id,
    n.article_title,
    n.article_url,
    n.source_name,
    n.published_at,
    n.chunk_text,
    ts_rank_cd(n.chunk_tsv, plainto_tsquery('english', query_text)) AS rank
  FROM public.news_chunks n
  WHERE n.chunk_tsv @@ plainto_tsquery('english', query_text)
  ORDER BY rank DESC
  LIMIT match_count;
$$;

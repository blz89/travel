/**
 * lib/host.js —— 景区网址的「来源分层」唯一实现（spot_link.js 与 spots_emit.js 共用）
 *
 * 五档只做两件事：同分裁决、给客户看来源标注（urlLabel）。**合格与否由要点密度判，不看域名。**
 * 为什么抽到这里：源类型标注原先只有 spot_link 里一份，spots_emit 拿不到 → 只能一律写"官网"，
 * 把文旅局页也标成官网。同一事实两处实现，必然漂移。
 */
const AGGREGATOR = /(^|\.)(58\.com|qq\.com|sohu\.com|sina\.com\.cn|163\.com|baidu\.com|toutiao\.com|zhihu\.com|xiaohongshu\.com|dianping\.com|mafengwo\.cn|qunar\.com|ctrip\.com|trip\.com|ly\.com)$/i;
const MEDIA = /(^|\.)(people\.com\.cn|xinhuanet\.com|news\.cn|gmw\.cn|china\.com\.cn|cctv\.com|chinanews\.com\.cn|rmhb\.com\.cn|thepaper\.cn)$/i;
const ASSOC = /(^|\.)(org\.cn|unesco\.org|cngj\.org|chinanpa\.org)$/i;
const TIER_LABEL = { gov: '文旅局/管委会', assoc: '官方名录', media: '媒体专题', site: '官网', aggregator: '网络转载' };

function hostTier(url) {
  try {
    const h = new URL(url).hostname;
    if (/\.gov\.cn$/i.test(h)) return 'gov';
    if (AGGREGATOR.test(h)) return 'aggregator';
    if (MEDIA.test(h)) return 'media';
    if (ASSOC.test(h)) return 'assoc';
    return 'site'; // 候选本来就来自「<景区名> 官网」检索，非上述域按景区自建站看
  } catch (_) { return 'aggregator'; }
}

const tierLabel = (url) => TIER_LABEL[hostTier(url)] || '网络转载';

module.exports = { hostTier, tierLabel, TIER_LABEL };

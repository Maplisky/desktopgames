import { AnimatePresence, motion } from 'framer-motion';
import { useGame } from '../store';
import { CARDS } from '@dg/games-night-of-ninja';

const HOUSE_LABEL: Record<string, string> = { crane: '鹤之家', lotus: '莲之家', ronin: '浪人' };

export default function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismissToast);
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast ${t.err ? 'err' : ''}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            onClick={() => dismiss(t.id)}
          >
            {t.text}
            {t.identity && (
              <div className="identity-line">
                <span className={`identity-badge ${t.identity.house}`}>
                  {HOUSE_LABEL[t.identity.house] ?? t.identity.house}
                  {t.identity.house !== 'ronin' && ` · 第 ${t.identity.rank} 席`}
                </span>
                {t.identity.otherCard && (
                  <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>
                    其打出的牌：{CARDS[t.identity.otherCard.split('#')[0]]?.name ?? t.identity.otherCard}
                  </span>
                )}
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

import { motion } from 'framer-motion';
import { CARDS, parseInst } from '@dg/games-night-of-ninja';
import { audio } from '../audio';

const TAG_TEXT: Record<string, string> = {
  info: '情报',
  trickster: '诡术',
  kill: '暗杀',
  reaction: '反应',
  kicker: '决胜',
};

export function NinjaCard({
  cardId,
  faceDown = false,
  clickable = false,
  selected = false,
  width = 92,
  onClick,
  title,
}: {
  cardId: string;
  faceDown?: boolean;
  clickable?: boolean;
  selected?: boolean;
  width?: number;
  onClick?: () => void;
  title?: string;
}) {
  const inst = parseInst(cardId);
  const card = CARDS[inst.id];
  const corner = inst.number || card?.number;
  return (
    <motion.div
      className={`card3d ${faceDown ? '' : 'flipped'} ${clickable ? 'clickable' : ''} ${selected ? 'selected' : ''}`}
      style={{ '--card-w': `${width}px`, width } as React.CSSProperties}
      initial={{ scale: 0.6, opacity: 0, y: 20 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.5, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      whileHover={clickable ? { y: -10 } : undefined}
      onClick={() => {
        if (clickable && onClick) {
          audio.sfx('click');
          onClick();
        }
      }}
      title={title ?? (card ? `${card.name}（${card.desc}）` : cardId)}
    >
      <div className="inner">
        <div className="back">
          <span className="crest">忍</span>
        </div>
        <div className="face">
          {card && (
            <>
              {corner ? <span className="phase-num">{corner}</span> : null}
              <span className="glyph">{card.glyph}</span>
              <span className="name">{card.name}</span>
              <span className="tagline">{TAG_TEXT[card.tag] ?? ''}</span>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

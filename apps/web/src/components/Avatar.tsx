/**
 * 头像渲染：表情字符串直接显示；data:image 开头则渲染为圆形图片。
 */
export default function Avatar({
  avatar,
  size = 28,
  className,
}: {
  avatar: string;
  size?: number;
  className?: string;
}) {
  if (avatar.startsWith('data:image')) {
    return (
      <img
        src={avatar}
        width={size}
        height={size}
        alt=""
        className={`avatar-img ${className ?? ''}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className={className} style={{ fontSize: size, lineHeight: 1 }}>
      {avatar}
    </span>
  );
}

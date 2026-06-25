import { useEffect, useRef } from 'react';

interface Node {
  x: number;
  y: number;
  phase: number;
  radius: number;
}

export function NeuralNetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let nodes: Node[] = [];
    let primaryColor = '#8b8dff';
    // 逻辑像素尺寸（scale 后绘制坐标基于逻辑像素，避免高 DPI 屏发虚）
    let logicalWidth = 0;
    let logicalHeight = 0;

    // 从 CSS 变量获取主题主色
    const updateColor = () => {
      const styles = getComputedStyle(document.documentElement);
      const color = styles.getPropertyValue('--rd-primary').trim();
      if (color) primaryColor = color;
    };
    updateColor();

    // 将 hex 色转为 rgba
    const hexToRgba = (hex: string, alpha: number): string => {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      // 高 DPI 屏幕需乘 devicePixelRatio 避免发虚
      const dpr = window.devicePixelRatio || 1;
      logicalWidth = parent.clientWidth;
      logicalHeight = parent.clientHeight;
      canvas.width = logicalWidth * dpr;
      canvas.height = logicalHeight * dpr;
      canvas.style.width = `${logicalWidth}px`;
      canvas.style.height = `${logicalHeight}px`;
      // 设置 canvas 尺寸会重置变换矩阵，重新 scale 使绘制坐标基于逻辑像素
      ctx.scale(dpr, dpr);
      generateNodes();
    };

    const generateNodes = () => {
      const count = 8 + Math.floor(Math.random() * 5);
      nodes = [];
      for (let i = 0; i < count; i++) {
        nodes.push({
          x: Math.random() * logicalWidth,
          // 节点偏上：y 坐标限制在上方 60% 区域
          y: Math.random() * (logicalHeight * 0.6),
          phase: Math.random() * Math.PI * 2,
          // 节点更小
          radius: 1 + Math.random() * 1.5,
        });
      }
    };

    const connectDistance = 200;

    const draw = (time: number) => {
      ctx.clearRect(0, 0, logicalWidth, logicalHeight);

      // 先画连线（在节点下方）
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectDistance) {
            const alpha = (1 - dist / connectDistance) * 0.25;
            ctx.strokeStyle = hexToRgba(primaryColor, alpha);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // 再画节点
      for (const node of nodes) {
        // 增大闪烁幅度（0.1~1.0）和速度（0.0018），让呼吸效果更明显
        const breath = 0.1 + 0.9 * (0.5 + 0.5 * Math.sin(time * 0.0018 + node.phase));
        // 外层光晕
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 4);
        glow.addColorStop(0, hexToRgba(primaryColor, breath * 0.4));
        glow.addColorStop(1, hexToRgba(primaryColor, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 4, 0, Math.PI * 2);
        ctx.fill();

        // 节点核心
        ctx.fillStyle = hexToRgba(primaryColor, breath);
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      animationId = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);

    // 监听主题变化
    const observer = new MutationObserver(() => {
      updateColor();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    animationId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: 'none' }}
    />
  );
}

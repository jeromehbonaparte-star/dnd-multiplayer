// ============================================
// Weather Effects Module
// Optional lightweight canvas particle overlay
// ============================================

const WEATHER_TYPES = ['none', 'rain', 'snow'];

class WeatherEffect {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.type = 'none';
    this.animationId = null;
    this.maxParticles = 80;

    // Bind the animate method
    this._animate = this._animate.bind(this);

    // Handle resize
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
    this._resize();
  }

  _resize() {
    const container = this.canvas.parentElement;
    if (!container) return;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;
  }

  setType(type) {
    if (!WEATHER_TYPES.includes(type)) return;

    this.type = type;
    this.particles = [];

    if (type === 'none') {
      this.stop();
      this.canvas.style.display = 'none';
    } else {
      this.canvas.style.display = 'block';
      this._initParticles();
      this.start();
    }
  }

  _initParticles() {
    this.particles = [];
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push(this._createParticle(true));
    }
  }

  _createParticle(randomY = false) {
    const w = this.canvas.width || 300;
    const h = this.canvas.height || 400;

    if (this.type === 'rain') {
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : -10,
        speed: 4 + Math.random() * 4,
        length: 8 + Math.random() * 12,
        opacity: 0.2 + Math.random() * 0.4
      };
    } else if (this.type === 'snow') {
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : -10,
        speed: 0.5 + Math.random() * 1.5,
        radius: 1 + Math.random() * 2.5,
        drift: (Math.random() - 0.5) * 0.8,
        opacity: 0.3 + Math.random() * 0.5
      };
    }
    return {};
  }

  start() {
    if (this.animationId) return;
    this._animate();
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // Clear canvas
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _animate() {
    if (this.type === 'none') return;

    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (this.type === 'rain') {
      this._drawRain(ctx, w, h);
    } else if (this.type === 'snow') {
      this._drawSnow(ctx, w, h);
    }

    this.animationId = requestAnimationFrame(this._animate);
  }

  _drawRain(ctx, w, h) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - 1, p.y + p.length);
      ctx.strokeStyle = `rgba(120, 160, 220, ${p.opacity})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      p.y += p.speed;
      p.x -= 0.5; // Slight wind

      if (p.y > h) {
        this.particles[i] = this._createParticle(false);
      }
    }
  }

  _drawSnow(ctx, w, h) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
      ctx.fill();

      p.y += p.speed;
      p.x += p.drift + Math.sin(p.y * 0.01) * 0.3;

      if (p.y > h || p.x < -10 || p.x > w + 10) {
        this.particles[i] = this._createParticle(false);
      }
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._resizeHandler);
    this.particles = [];
  }

  getType() {
    return this.type;
  }

  cycleType() {
    const currentIndex = WEATHER_TYPES.indexOf(this.type);
    const nextIndex = (currentIndex + 1) % WEATHER_TYPES.length;
    this.setType(WEATHER_TYPES[nextIndex]);
    return this.type;
  }
}

// Singleton instance
let _weatherInstance = null;

/**
 * Initialize the weather effect system.
 * Safe to call multiple times - will only create one instance.
 */
export function initWeather() {
  const canvas = document.getElementById('weather-canvas');
  if (!canvas) return null;

  if (!_weatherInstance) {
    _weatherInstance = new WeatherEffect(canvas);
    // Start hidden
    canvas.style.display = 'none';
  }

  return _weatherInstance;
}

/**
 * Get the weather effect instance.
 */
export function getWeather() {
  return _weatherInstance;
}

/**
 * Cycle through weather types: none -> rain -> snow -> none
 * Returns the new weather type string.
 */
export function cycleWeather() {
  if (!_weatherInstance) {
    initWeather();
  }
  if (!_weatherInstance) return 'none';

  const newType = _weatherInstance.cycleType();
  updateWeatherButton(newType);
  return newType;
}

/**
 * Set weather to a specific type.
 */
export function setWeather(type) {
  if (!_weatherInstance) {
    initWeather();
  }
  if (!_weatherInstance) return;

  _weatherInstance.setType(type);
  updateWeatherButton(type);
}

/**
 * Update the weather toggle button appearance.
 */
function updateWeatherButton(type) {
  const btn = document.getElementById('weather-toggle-btn');
  if (!btn) return;

  const labels = {
    none: { text: '\u2614', title: 'Weather: None' },
    rain: { text: '\uD83C\uDF27\uFE0F', title: 'Weather: Rain' },
    snow: { text: '\u2744\uFE0F', title: 'Weather: Snow' }
  };

  const info = labels[type] || labels.none;
  btn.innerHTML = info.text;
  btn.title = info.title;
  btn.classList.toggle('weather-active', type !== 'none');
}

/** One frame of player intent, independent of the device it came from. */
export interface InputFrame {
  /** -1 to 1, positive is forward. */
  forward: number;
  /** -1 to 1, positive is right. */
  strafe: number;
  jump: boolean;
  /** Look change since the last frame, in radians. Positive turns right and looks down. */
  lookX: number;
  lookY: number;
  /** Pressed this frame. Defaults: remove a block. */
  primary: boolean;
  /** Pressed this frame. Defaults: place a block. */
  secondary: boolean;
  /** A hotbar slot chosen this frame, from 0, or null. */
  select: number | null;
}

export interface InputOptions {
  /** Radians per pixel of mouse movement. */
  mouseSensitivity?: number;
  /** Radians per pixel of touch drag. */
  touchSensitivity?: number;
  /** Show on-screen touch controls. "auto" shows them on touch screens. */
  touch?: "auto" | boolean;
  /** Where touch controls are added. Defaults to the element's parent. */
  touchContainer?: HTMLElement;
  /** Labels for the on-screen buttons. */
  touchLabels?: { primary?: string; secondary?: string; jump?: string };
  onPointerLockChange?(locked: boolean): void;
}

const KEYS: Record<string, "forward" | "back" | "left" | "right" | "jump"> = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  Space: "jump",
};

export function isTouchScreen(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);
}

/**
 * Collects keyboard, mouse and touch input into InputFrames. Call consume()
 * once per frame. The game decides what the actions mean.
 */
export class InputManager {
  private readonly held = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private primary = false;
  private secondary = false;
  private select: number | null = null;
  private locked = false;
  private readonly cleanup: (() => void)[] = [];
  private readonly touch: TouchControls | null;
  private readonly mouseSensitivity: number;

  constructor(private readonly element: HTMLElement, options: InputOptions = {}) {
    this.mouseSensitivity = options.mouseSensitivity ?? 0.0025;
    const wantsTouch = options.touch === "auto" || options.touch === undefined ? isTouchScreen() : options.touch;

    this.listen(window, "keydown", (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const action = KEYS[e.code];
      if (action) {
        this.held.add(action);
        e.preventDefault();
      }
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.select = Number(digit[1]) - 1;
    });
    this.listen(window, "keyup", (e: KeyboardEvent) => {
      const action = KEYS[e.code];
      if (action) this.held.delete(action);
    });
    // Losing focus or hiding the tab must not leave a key or a stick held down:
    // the release event never arrives, and the player would walk on forever.
    this.listen(window, "blur", () => this.release());
    this.listen(document, "visibilitychange", () => {
      if (document.hidden) this.release();
    });

    if (!wantsTouch) {
      this.listen(element, "click", () => {
        if (!this.locked) {
          const request = element.requestPointerLock?.() as unknown as Promise<void> | undefined;
          request?.catch?.(() => undefined);
        }
      });
      this.listen(document, "pointerlockchange", () => {
        this.locked = document.pointerLockElement === element;
        if (!this.locked) this.held.clear();
        options.onPointerLockChange?.(this.locked);
      });
      this.listen(document, "mousemove", (e: MouseEvent) => {
        if (!this.locked) return;
        this.lookX += e.movementX * this.mouseSensitivity;
        this.lookY += e.movementY * this.mouseSensitivity;
      });
      this.listen(document, "mousedown", (e: MouseEvent) => {
        if (!this.locked) return;
        if (e.button === 0) this.primary = true;
        if (e.button === 2) this.secondary = true;
      });
      this.listen(element, "contextmenu", (e: Event) => e.preventDefault());
    }

    this.touch = wantsTouch
      ? new TouchControls(
          options.touchContainer ?? element.parentElement ?? document.body,
          options.touchSensitivity ?? 0.006,
          { primary: "Remove", secondary: "Place", jump: "Jump", ...options.touchLabels },
        )
      : null;
  }

  /** Lets go of everything held: keys, the move stick, the jump button. */
  release(): void {
    this.held.clear();
    this.touch?.release();
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  get usesTouch(): boolean {
    return this.touch !== null;
  }

  consume(): InputFrame {
    let forward = (this.held.has("forward") ? 1 : 0) - (this.held.has("back") ? 1 : 0);
    let strafe = (this.held.has("right") ? 1 : 0) - (this.held.has("left") ? 1 : 0);
    let jump = this.held.has("jump");
    let lookX = this.lookX;
    let lookY = this.lookY;
    let primary = this.primary;
    let secondary = this.secondary;

    if (this.touch) {
      const t = this.touch.consume();
      if (t.forward !== 0 || t.strafe !== 0) {
        forward = t.forward;
        strafe = t.strafe;
      }
      jump ||= t.jump;
      lookX += t.lookX;
      lookY += t.lookY;
      primary ||= t.primary;
      secondary ||= t.secondary;
    }

    const frame: InputFrame = { forward, strafe, jump, lookX, lookY, primary, secondary, select: this.select };
    this.lookX = this.lookY = 0;
    this.primary = this.secondary = false;
    this.select = null;
    return frame;
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.touch?.dispose();
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  private listen<E extends Event>(target: EventTarget, type: string, handler: (event: E) => void): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, { passive: false });
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }
}

/**
 * On-screen controls: drag anywhere on the left to move, drag on the right to
 * look, and three buttons. Uses pointer events, so it also works with a mouse.
 */
class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private movePointer: number | null = null;
  private moveOrigin: [number, number] = [0, 0];
  private lookPointer: number | null = null;
  private lookLast: [number, number] = [0, 0];
  private forward = 0;
  private strafe = 0;
  private jump = false;
  private lookX = 0;
  private lookY = 0;
  private primary = false;
  private secondary = false;
  private readonly radius = 56;

  constructor(
    container: HTMLElement,
    private readonly sensitivity: number,
    labels: { primary: string; secondary: string; jump: string },
  ) {
    this.root = el("div", {
      position: "absolute", inset: "0", touchAction: "none", userSelect: "none",
      webkitUserSelect: "none", zIndex: "5",
    });
    this.root.dataset.cubitTouch = "";
    const moveZone = el("div", { position: "absolute", left: "0", top: "0", bottom: "0", width: "45%" });
    const lookZone = el("div", { position: "absolute", right: "0", top: "0", bottom: "0", width: "55%" });
    this.stick = el("div", {
      position: "absolute", width: `${this.radius * 2}px`, height: `${this.radius * 2}px`, borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.55)", background: "rgba(0,0,0,0.15)", display: "none", pointerEvents: "none",
    });
    this.knob = el("div", {
      position: "absolute", width: "48px", height: "48px", borderRadius: "50%", left: `${this.radius - 24}px`,
      top: `${this.radius - 24}px`, background: "rgba(255,255,255,0.7)",
    });
    this.stick.append(this.knob);
    this.root.append(moveZone, lookZone, this.stick);

    const buttons = el("div", {
      position: "absolute", right: "16px", bottom: "calc(16px + env(safe-area-inset-bottom))",
      display: "flex", gap: "12px", alignItems: "flex-end",
    });
    buttons.append(
      this.button(labels.primary, () => (this.primary = true)),
      this.button(labels.secondary, () => (this.secondary = true)),
      this.button(labels.jump, () => (this.jump = true), () => (this.jump = false), true),
    );
    this.root.append(buttons);
    container.append(this.root);

    moveZone.addEventListener("pointerdown", (e) => {
      if (this.movePointer !== null) return;
      this.movePointer = e.pointerId;
      moveZone.setPointerCapture(e.pointerId);
      const box = this.root.getBoundingClientRect();
      this.moveOrigin = [e.clientX, e.clientY];
      Object.assign(this.stick.style, {
        display: "block", left: `${e.clientX - box.left - this.radius}px`, top: `${e.clientY - box.top - this.radius}px`,
      });
    });
    moveZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.movePointer) return;
      let dx = e.clientX - this.moveOrigin[0];
      let dy = e.clientY - this.moveOrigin[1];
      const length = Math.hypot(dx, dy);
      if (length > this.radius) {
        dx = (dx / length) * this.radius;
        dy = (dy / length) * this.radius;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.strafe = dx / this.radius;
      this.forward = -dy / this.radius;
    });
    const endMove = (e: PointerEvent) => {
      if (e.pointerId !== this.movePointer) return;
      this.movePointer = null;
      this.forward = this.strafe = 0;
      this.stick.style.display = "none";
      this.knob.style.transform = "";
    };
    moveZone.addEventListener("pointerup", endMove);
    moveZone.addEventListener("pointercancel", endMove);
    moveZone.addEventListener("lostpointercapture", endMove);

    lookZone.addEventListener("pointerdown", (e) => {
      if (this.lookPointer !== null) return;
      this.lookPointer = e.pointerId;
      lookZone.setPointerCapture(e.pointerId);
      this.lookLast = [e.clientX, e.clientY];
    });
    lookZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookPointer) return;
      this.lookX += (e.clientX - this.lookLast[0]) * this.sensitivity;
      this.lookY += (e.clientY - this.lookLast[1]) * this.sensitivity;
      this.lookLast = [e.clientX, e.clientY];
    });
    const endLook = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = null;
    };
    lookZone.addEventListener("pointerup", endLook);
    lookZone.addEventListener("pointercancel", endLook);
    lookZone.addEventListener("lostpointercapture", endLook);
  }

  consume() {
    const frame = {
      forward: this.forward, strafe: this.strafe, jump: this.jump,
      lookX: this.lookX, lookY: this.lookY, primary: this.primary, secondary: this.secondary,
    };
    this.lookX = this.lookY = 0;
    this.primary = this.secondary = false;
    return frame;
  }

  release(): void {
    this.movePointer = this.lookPointer = null;
    this.forward = this.strafe = 0;
    this.jump = false;
    this.stick.style.display = "none";
    this.knob.style.transform = "";
  }

  dispose(): void {
    this.root.remove();
  }

  private button(label: string, down: () => void, up?: () => void, large = false): HTMLButtonElement {
    const size = large ? "76px" : "60px";
    const b = el("button", {
      width: size, height: size, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.7)",
      background: "rgba(0,0,0,0.3)", color: "white", font: "600 13px system-ui, sans-serif", touchAction: "none",
    });
    b.type = "button";
    b.textContent = label;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      down();
    });
    if (up) {
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
    }
    return b;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Record<string, string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
}

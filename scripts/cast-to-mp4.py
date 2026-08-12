#!/usr/bin/env python3
"""
Render asciinema cast to MP4 directly using PIL.
No frame cap — renders at true 30fps.
"""
import json, sys, os, re
from PIL import Image, ImageDraw, ImageFont

# Config
FPS = 30
FONT_SIZE = 18
COLS = 80
ROWS = 24
CHAR_W = 11  # approx for JetBrains Mono 18px
CHAR_H = 24
MARGIN = 20
WIDTH = COLS * CHAR_W + MARGIN * 2
HEIGHT = ROWS * CHAR_H + MARGIN * 2

# Monokai theme colors
BG = (39, 40, 34)
FG = (248, 248, 242)
COLORS = {
    30: (248, 248, 242),  # black
    31: (255, 85, 85),    # red
    32: (166, 226, 46),   # green
    33: (230, 219, 116),  # yellow
    34: (102, 217, 239),  # blue
    35: (174, 129, 255),  # magenta
    36: (161, 239, 239),  # cyan
    37: (248, 248, 242),  # white
    90: (150, 152, 150),  # bright black (gray)
    91: (255, 85, 85),
    92: (166, 226, 46),
    93: (230, 219, 116),
    94: (102, 217, 239),
    95: (174, 129, 255),
    96: (161, 239, 239),
    97: (248, 248, 242),
}

def load_font():
    # Menlo.ttc is a TrueType Collection — needs index parameter
    # It has full box-drawing char support (┌─┐│└┘ etc.)
    try:
        return ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", FONT_SIZE, index=0)
    except:
        pass
    for p in [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Monaco.ttf",
        "/Library/Fonts/JetBrains Mono Regular.ttf",
    ]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, FONT_SIZE)
            except:
                continue
    return ImageFont.load_default()

font = load_font()
# Load bold variant for ANSI bold (code 1)
try:
    font_bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", FONT_SIZE, index=1)
except:
    font_bold = font

# Measure actual char width from font
try:
    _bbox = font.getbbox("M")
    CHAR_W = _bbox[2] - _bbox[0] + 1
    _bbox_h = font.getbbox("M|")
    CHAR_H = max(24, (_bbox_h[3] - _bbox_h[1]) + 8)
except:
    pass

def parse_ansi(text):
    """Parse ANSI escape sequences and return list of (char, color, bold) tuples.
    Also returns control commands: ('clear',), ('home',), ('clearend',)"""
    result = []
    i = 0
    color = FG
    bold = False
    while i < len(text):
        if text[i] == '\x1b' and i + 1 < len(text) and text[i+1] == '[':
            # Find end of escape sequence — could end in 'm' (SGR), 'J' (erase), 'H' (cursor), 'K', etc.
            j = i + 2
            while j < len(text) and text[j] not in 'mJHKABCDf':
                j += 1
            if j < len(text):
                cmd = text[j]
                params = text[i+2:j]
                if cmd == 'm':
                    # SGR — color/bold
                    codes = params.split(';')
                    for code in codes:
                        if not code:
                            continue
                        c = int(code)
                        if c == 0:
                            color = FG
                            bold = False
                        elif c == 1:
                            bold = True
                        elif c in COLORS:
                            color = COLORS[c]
                elif cmd == 'J':
                    # Erase display: 2J = clear all, 0J = clear from cursor to end
                    result.append(('clear', color, bold))
                elif cmd == 'H':
                    # Cursor home
                    result.append(('home', color, bold))
                elif cmd == 'K':
                    # Erase line: 0K = cursor to end, 2K = entire line
                    result.append(('clearend', color, bold))
                # Ignore other cursor movement (A,B,C,D,f)
                i = j + 1
                continue
        if text[i] == '\r':
            # Carriage return — reset cursor to start of line (for counter animation)
            result.append(('\r', color, bold))
            i += 1
            continue
        if text[i] == '\n':
            result.append(('\n', color, bold))
            i += 1
            continue
        result.append((text[i], color, bold))
        i += 1
    return result

def render_frame(screen, cursor_row, cursor_col):
    """Render screen state to PIL Image."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)
    
    for row_idx, row in enumerate(screen[:ROWS]):
        col_idx = 0
        for char, color, bold in row:
            if char == '\n':
                break
            if col_idx >= COLS:
                break
            x = MARGIN + col_idx * CHAR_W
            y = MARGIN + row_idx * CHAR_H
            if char != ' ':
                f = font_bold if bold else font
                draw.text((x, y), char, fill=color, font=f)
            col_idx += 1
    
    return img

def update_screen(screen, data, cursor_row, cursor_col):
    """Update screen buffer with new data."""
    chars = parse_ansi(data)
    for item in chars:
        char, color, bold = item[0], item[1], item[2]
        # Handle control commands
        if char == 'clear':
            for r in range(ROWS):
                screen[r] = []
            cursor_row = 0
            cursor_col = 0
            continue
        if char == 'home':
            cursor_row = 0
            cursor_col = 0
            continue
        if char == 'clearend':
            if cursor_row < ROWS:
                screen[cursor_row] = screen[cursor_row][:cursor_col]
            continue
        if char == '\n':
            cursor_row += 1
            cursor_col = 0
            if cursor_row >= ROWS:
                screen.pop(0)
                screen.append([])
                cursor_row = ROWS - 1
            continue
        if char == '\r':
            cursor_col = 0
            continue
        if char == '\x08':  # backspace
            cursor_col = max(0, cursor_col - 1)
            continue
        # Ensure row exists
        while len(screen) <= cursor_row:
            screen.append([])
        # Ensure col exists
        while len(screen[cursor_row]) <= cursor_col:
            screen[cursor_row].append((' ', FG, False))
        # Set char
        screen[cursor_row][cursor_col] = (char, color, bold)
        cursor_col += 1
        if cursor_col >= COLS:
            cursor_row += 1
            cursor_col = 0
            if cursor_row >= ROWS:
                screen.pop(0)
                screen.append([])
                cursor_row = ROWS - 1
    return cursor_row, cursor_col

def main():
    cast_path = sys.argv[1]
    output_path = sys.argv[2]
    
    with open(cast_path) as f:
        lines = f.readlines()
    
    events = []
    for line in lines[1:]:
        line = line.strip()
        if not line: continue
        parts = json.loads(line)
        if isinstance(parts, list) and len(parts) >= 3 and parts[1] == 'o':
            events.append((parts[0], parts[2]))
    
    total_duration = sum(t for t, _ in events)
    total_frames = int(total_duration * FPS)
    print(f"Duration: {total_duration:.1f}s, Frames: {total_frames}, FPS: {FPS}")
    
    # Process events and generate frames
    screen = [[] for _ in range(ROWS)]
    cursor_row, cursor_col = 0, 0
    
    frames = []
    event_idx = 0
    current_time = 0.0
    frame_time = 1.0 / FPS
    
    for frame_num in range(total_frames):
        # Process all events that occur before this frame
        while event_idx < len(events) and current_time >= sum(e[0] for e in events[:event_idx+1]):
            delay, data = events[event_idx]
            cursor_row, cursor_col = update_screen(screen, data, cursor_row, cursor_col)
            event_idx += 1
        
        # Render frame
        img = render_frame(screen, cursor_row, cursor_col)
        frames.append(img)
        current_time += frame_time
        
        if frame_num % 100 == 0:
            print(f"  Frame {frame_num}/{total_frames}...")
    
    # Save as MP4 using ffmpeg
    print(f"Saving {len(frames)} frames to {output_path}...")
    # Save frames as PNG sequence first
    tmp_dir = "/tmp/demo-frames"
    os.makedirs(tmp_dir, exist_ok=True)
    for i, frame in enumerate(frames):
        frame.save(f"{tmp_dir}/frame_{i:05d}.png")
    
    # Use ffmpeg to create MP4
    os.system(f"ffmpeg -y -framerate {FPS} -i {tmp_dir}/frame_%05d.png -c:v libx264 -preset fast -pix_fmt yuv420p -movflags faststart {output_path} 2>/dev/null")
    
    # Cleanup
    os.system(f"rm -rf {tmp_dir}")
    print(f"Done: {output_path}")

if __name__ == "__main__":
    main()

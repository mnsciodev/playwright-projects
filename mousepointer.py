from pynput import mouse, keyboard
 
# ---------------- Globals ----------------
mouse_capture_active = False
keyboard_capture_active = False
mouse_positions = []
keyboard_keys = []
 
# ---------------- Mouse Callbacks ----------------
def on_move(x, y):
    if mouse_capture_active:
        mouse_positions.append((x, y))
        print(f"Mouse moved to ({x}, {y})")
 
def on_click(x, y, button, pressed):
    if mouse_capture_active:
        action = "Pressed" if pressed else "Released"
        print(f"{action} {button} at ({x}, {y})")
 
def on_scroll(x, y, dx, dy):
    if mouse_capture_active:
        print(f"Scrolled at ({x}, {y}) by ({dx}, {dy})")
 
# ---------------- Keyboard Callbacks ----------------
def on_press(key):
    global keyboard_keys
    if keyboard_capture_active:
        try:
            keyboard_keys.append(key.char)
            print(f"Key pressed: {key.char}")
        except AttributeError:
            keyboard_keys.append(str(key))
            print(f"Special key pressed: {key}")
 
def on_release(key):
    if key == keyboard.Key.esc:
        # Stop everything on ESC
        return False
 
# ---------------- Hotkey Callbacks ----------------
def toggle_mouse_capture():
    global mouse_capture_active
    mouse_capture_active = not mouse_capture_active
    print(f"Mouse capture {'started' if mouse_capture_active else 'stopped'}")
 
def toggle_keyboard_capture():
    global keyboard_capture_active
    keyboard_capture_active = not keyboard_capture_active
    print(f"Keyboard capture {'started' if keyboard_capture_active else 'stopped'}")
 
# ---------------- Start Listeners ----------------
mouse_listener = mouse.Listener(on_move=on_move, on_click=on_click, on_scroll=on_scroll)
keyboard_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
 
mouse_listener.start()
keyboard_listener.start()
 
# ---------------- Global Hotkeys ----------------
from pynput.keyboard import Key, GlobalHotKeys
 
hotkeys = GlobalHotKeys({
    '<alt>+m': toggle_mouse_capture,
    '<alt>+k': toggle_keyboard_capture
})
hotkeys.start()
 
print("Tracking mouse and keyboard with hotkeys:")
print("Press Alt+M to toggle mouse capture.")
print("Press Alt+K to toggle keyboard capture.")
print("Press ESC to stop everything.")
 
# Keep main thread alive
mouse_listener.join()
keyboard_listener.join()
hotkeys.join()
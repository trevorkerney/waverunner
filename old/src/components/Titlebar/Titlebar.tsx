import { appWindow } from '@tauri-apps/api/window';

import './Titlebar.css'

const Titlebar = () => {
  return (
    <div data-tauri-drag-region id='titlebar'>
      <div id='win-btn-box'>
        <button onClick={() => {appWindow.minimize()}}>
          <img src='/icons/minus.png' alt='minimize' />
        </button>
        <button onClick={() => {appWindow.maximize()}}>
          <img src='/icons/maximize.png' alt='maximize' />
        </button>
        <button onClick={() => {appWindow.close()}}>
          <img src='/icons/x.png' alt='exit' />
        </button>
      </div>
    </div>
  )
};

export default Titlebar;
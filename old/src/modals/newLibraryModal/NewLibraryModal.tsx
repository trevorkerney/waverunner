import { dialog, invoke } from '@tauri-apps/api'

import { useState } from 'react';

import './NewLibraryModal.css'

enum Format {
  None, Movie, TV, Music
}

enum Indexing {
  Simple, Nested
}

type FIR = {
  format: Format,
  idx: Indexing[]
}

const format_indexing: FIR[] = [
  {
    format: Format.None,
    idx: []
  },
  {
    format: Format.Movie,
    idx: [
      Indexing.Simple,
      Indexing.Nested,
    ]
  },
  {
    format: Format.TV,
    idx: [
      Indexing.Simple
    ]
  },
  {
    format: Format.Music,
    idx: [
      Indexing.Simple
    ]
  }
]



const NewLibraryModal = (props: {
  exitModal: () => void,
}) => {

  

  const [name, setName] = useState<string>('');
  const [path, setPath] = useState<string>('');
  const [format, _setFormat] = useState<Format>(Format.Movie);
  const [indexing, setIndexing] = useState<Indexing>(Indexing.Simple);
  const setFormat = (format: Format) => {
    if (!format) setIndexing(Indexing.Simple);
    _setFormat(format);
  };
  const [metadata, setMetadata] = useState<boolean>(true);
  const [portable, setPortable] = useState<boolean>(true);

  const createLibrary = () => {

  };

  return (
    <div id='new-lib-modal'>
      <div id='exit-box'>
        <button onClick={() => { props.exitModal() }}>
          <img src='/icons/x.png' alt="close modal" />
        </button>
      </div>

      <h1>new library</h1>

      <div className='v-box text-in-box'>
        <label htmlFor='lib-name' className='main-label'>library name</label>
        <input
          id='lib-name'
          type="text"
          placeholder='Films'
          value={name}
          onChange={e => {
            setName(e.target.value);
          }}
        />
      </div>

      <div className='v-box text-in-box'>
        <label htmlFor='lib-path' className='main-label'>path</label>
        <input
          id='lib-path'
          type="text"
          placeholder='C:\path\to\media'
          value={path}
          onChange={e => {
            setPath(e.target.value);
          }}
        />
        <div>
          <button
            onClick={async () => {
              const selpath: string | null = (await dialog.open({directory: true}) as string | null);
              setPath((selpath) ? selpath : "")
            }}
          >browse...</button>
        </div>
      </div>

      <div className='v-box btn-wrap-box'>
        <label className='main-label'>format</label>
        <div onChange={e => setFormat(parseInt((e.target as HTMLInputElement).value))}>
          <input 
            type='radio'
            id='fmt-movies'
            name='format'
            value={Format.Movie}
            defaultChecked={true}
          />
          <label htmlFor='fmt-movies'>movies</label>
          <input 
            type='radio'
            id='fmt-tv'
            name='format'
            value={Format.TV}
          />
          <label htmlFor='fmt-tv'>tv</label>
          <input 
            type='radio'
            id='fmt-music'
            name='format'
            value={Format.Music}
          />
          <label htmlFor='fmt-music'>music</label>
        </div>
      </div>

      <div id='indexing-box' className='v-box'>
        <label className='main-label'>indexing</label>
        <div className='radio-wrap-box'>
          <div className='rwb-opt'>
            <input 
              type='radio'
              id='ind-simple'
              value={Indexing.Simple}
              name='indexing'
              defaultChecked={true}
            />
            <label htmlFor='ind-simple'>
              <label>
                simple &nbsp;
                <i><a href='https://powsim.trevorkerney.com'>?</a></i>
              </label>
              <img src='/svg/simple_indexing.svg' alt='simple' />
            </label>
          </div>
          <div className='rwb-opt'>
            <input 
              type='radio'
              id='ind-nested'
              value={Indexing.Nested}
              name='indexing'
            />
            <label htmlFor='ind-nested'>
              <label>
                nested &nbsp;
                <i><a href='https://trevorkerney.com'>?</a></i>
              </label>
              <img src='/svg/nested_indexing.svg' alt='simple' />
            </label>
          </div>
        </div>
      </div>

      <div id='lib-options' className='v-box'>
        <label className='main-label'>options</label>
        <div>
          <input
            id='lo-meta'
            type='checkbox'
            checked={metadata}
            onChange={e => {
              setMetadata(e.target.checked);
            }}
          />
          <label htmlFor='lo-meta'>get metadata from tMDB</label>
        </div>
        <div>
          <input
            id='lo-port'
            type='checkbox'
            checked={portable}
            onChange={e => {
              setPortable(e.target.checked);
            }}
          />
          <label htmlFor='lo-port'>portable</label>
        </div>
      </div>

      <div id='submit-box'>
        <button onClick={createLibrary}>create</button>
      </div>

    </div>
  );
}

export default NewLibraryModal;

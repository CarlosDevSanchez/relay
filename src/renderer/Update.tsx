import type { UpdateResult } from '../shared/types'
import { Dialog } from './ui'

/** A newer release exists: notes as plain text (never HTML), Relay only opens the release page; the user downloads and replaces the app. */
export function UpdateDialog({ r, onClose, onSkip, onOpen }: { r: Extract<UpdateResult, { status: 'available' }>; onClose(): void; onSkip(): void; onOpen(): void }) {
  return (
    <Dialog label="Actualización disponible" onClose={onClose} boxClass="max-w-lg">
      <h3 className="text-base font-semibold">Relay v{r.info.version} disponible (tienes v{r.current})</h3>
      {r.info.notes && <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-box bg-base-200 p-3 font-sans text-xs">{r.info.notes}</pre>}
      <div className="mt-3 space-y-1 text-xs opacity-70">
        <p>Para actualizar: descarga el .dmg desde la página de la versión y sustituye Relay en Aplicaciones. Tus datos en ~/.relay se conservan.</p>
        <p>
          Como la app no está notarizada, el primer arranque pide permiso: Ajustes del Sistema &gt; Privacidad y seguridad &gt; «Abrir de todos modos», o ejecuta <code className="kbd kbd-xs">xattr -dr com.apple.quarantine /Applications/Relay.app</code>.
        </p>
      </div>
      <div className="modal-action">
        <button className="btn btn-ghost" data-autofocus onClick={onClose}>Más tarde</button>
        <button className="btn btn-ghost" onClick={onSkip}>Omitir esta versión</button>
        <button className="btn btn-primary" onClick={onOpen}>Descargar</button>
      </div>
    </Dialog>
  )
}

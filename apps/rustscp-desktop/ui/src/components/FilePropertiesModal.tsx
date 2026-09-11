import React, { useState, useEffect } from 'react';
import { 
  X, 
  Shield, 
  Check, 
  FileText, 
  Folder
} from 'lucide-react';
import { FileEntry } from '../types.ts';

interface FilePropertiesModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: FileEntry | null;
  onApplyPermissions: (path: string, mode: number) => Promise<void>;
}

export const FilePropertiesModal: React.FC<FilePropertiesModalProps> = ({
  isOpen,
  onClose,
  file,
  onApplyPermissions,
}) => {
  const [octal, setOctal] = useState<string>('0644');
  const [isApplying, setIsApplying] = useState<boolean>(false);

  // Checkbox states
  const [ownerR, setOwnerR] = useState<boolean>(true);
  const [ownerW, setOwnerW] = useState<boolean>(true);
  const [ownerX, setOwnerX] = useState<boolean>(false);

  const [groupR, setGroupR] = useState<boolean>(true);
  const [groupW, setGroupW] = useState<boolean>(false);
  const [groupX, setGroupX] = useState<boolean>(false);

  const [otherR, setOtherR] = useState<boolean>(true);
  const [otherW, setOtherW] = useState<boolean>(false);
  const [otherX, setOtherX] = useState<boolean>(false);

  useEffect(() => {
    if (!file) return;
    const mode = file.permissions.mode || 0o644;
    setOwnerR((mode & 0o400) !== 0);
    setOwnerW((mode & 0o200) !== 0);
    setOwnerX((mode & 0o100) !== 0);

    setGroupR((mode & 0o040) !== 0);
    setGroupW((mode & 0o020) !== 0);
    setGroupX((mode & 0o010) !== 0);

    setOtherR((mode & 0o004) !== 0);
    setOtherW((mode & 0o002) !== 0);
    setOtherX((mode & 0o001) !== 0);

    setOctal('0' + (mode & 0o777).toString(8));
  }, [file]);

  if (!isOpen || !file) return null;

  const updateFromCheckboxes = (
    oR: boolean, oW: boolean, oX: boolean,
    gR: boolean, gW: boolean, gX: boolean,
    tR: boolean, tW: boolean, tX: boolean
  ) => {
    let mode = 0;
    if (oR) mode |= 0o400;
    if (oW) mode |= 0o200;
    if (oX) mode |= 0o100;
    if (gR) mode |= 0o040;
    if (gW) mode |= 0o020;
    if (gX) mode |= 0o010;
    if (tR) mode |= 0o004;
    if (tW) mode |= 0o002;
    if (tX) mode |= 0o001;

    setOctal('0' + mode.toString(8));
  };

  const handleOctalChange = (val: string) => {
    setOctal(val);
    const parsed = parseInt(val, 8);
    if (!isNaN(parsed)) {
      setOwnerR((parsed & 0o400) !== 0);
      setOwnerW((parsed & 0o200) !== 0);
      setOwnerX((parsed & 0o100) !== 0);

      setGroupR((parsed & 0o040) !== 0);
      setGroupW((parsed & 0o020) !== 0);
      setGroupX((parsed & 0o010) !== 0);

      setOtherR((parsed & 0o004) !== 0);
      setOtherW((parsed & 0o002) !== 0);
      setOtherX((parsed & 0o001) !== 0);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const mode = parseInt(octal, 8);
      await onApplyPermissions(file.path, mode);
      onClose();
    } catch (err) {
      alert(`Erro ao aplicar permissões: ${err}`);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-md w-full shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center space-x-2">
            <Shield className="w-4 h-4 text-sky-500 dark:text-sky-400" />
            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-xs">Propriedades & Permissões (Chmod)</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          {/* File Meta Summary */}
          <div className="flex items-center space-x-3 bg-slate-50 dark:bg-dark-900/60 p-3 rounded-lg border border-slate-200 dark:border-dark-700">
            {file.file_type === 'directory' ? (
              <Folder className="w-6 h-6 text-amber-500 dark:text-amber-400" />
            ) : (
              <FileText className="w-6 h-6 text-sky-500 dark:text-sky-400" />
            )}
            <div className="min-w-0 flex-1">
              <span className="font-bold text-slate-900 dark:text-slate-100 truncate block">{file.name}</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate block">{file.path}</span>
              <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5 block">
                {file.size} bytes ({''})
              </span>
            </div>
          </div>

          {/* Permissions Matrix */}
          <div className="space-y-2">
            <span className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider text-[11px]">
              Permissões de Acesso (Unix Rights)
            </span>

            <table className="w-full text-center border-collapse border border-slate-200 dark:border-dark-700 rounded bg-white dark:bg-dark-900">
              <thead>
                <tr className="bg-slate-100 dark:bg-dark-750 text-[11px] text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-dark-700">
                  <th className="py-1.5 px-2 text-left">Entidade</th>
                  <th className="py-1.5 px-2">Leitura (r)</th>
                  <th className="py-1.5 px-2">Escrita (w)</th>
                  <th className="py-1.5 px-2">Execução (x)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-dark-700/50 text-xs">
                <tr>
                  <td className="py-2 px-2 text-left font-semibold text-slate-700 dark:text-slate-300">Dono (Owner)</td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={ownerR} 
                      onChange={(e) => {
                        setOwnerR(e.target.checked);
                        updateFromCheckboxes(e.target.checked, ownerW, ownerX, groupR, groupW, groupX, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={ownerW} 
                      onChange={(e) => {
                        setOwnerW(e.target.checked);
                        updateFromCheckboxes(ownerR, e.target.checked, ownerX, groupR, groupW, groupX, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={ownerX} 
                      onChange={(e) => {
                        setOwnerX(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, e.target.checked, groupR, groupW, groupX, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                </tr>

                <tr>
                  <td className="py-2 px-2 text-left font-semibold text-slate-700 dark:text-slate-300">Grupo (Group)</td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={groupR} 
                      onChange={(e) => {
                        setGroupR(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, e.target.checked, groupW, groupX, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={groupW} 
                      onChange={(e) => {
                        setGroupW(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, groupR, e.target.checked, groupX, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={groupX} 
                      onChange={(e) => {
                        setGroupX(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, groupR, groupW, e.target.checked, otherR, otherW, otherX);
                      }} 
                    />
                  </td>
                </tr>

                <tr>
                  <td className="py-2 px-2 text-left font-semibold text-slate-700 dark:text-slate-300">Outros (Others)</td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={otherR} 
                      onChange={(e) => {
                        setOtherR(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, groupR, groupW, groupX, e.target.checked, otherW, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={otherW} 
                      onChange={(e) => {
                        setOtherW(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, groupR, groupW, groupX, otherR, e.target.checked, otherX);
                      }} 
                    />
                  </td>
                  <td>
                    <input 
                      type="checkbox" 
                      checked={otherX} 
                      onChange={(e) => {
                        setOtherX(e.target.checked);
                        updateFromCheckboxes(ownerR, ownerW, ownerX, groupR, groupW, groupX, otherR, otherW, e.target.checked);
                      }} 
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Octal Value Input */}
          <div className="flex items-center space-x-3">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Notação Octal:</label>
            <input
              type="text"
              value={octal}
              onChange={(e) => handleOctalChange(e.target.value)}
              className="w-24 bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-700 rounded px-2 py-1 text-center font-mono font-bold text-sky-600 dark:text-sky-400 focus:outline-none focus:border-sky-500 shadow-sm"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-end space-x-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-slate-700 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-dark-700 font-sans transition-colors font-medium">
            Cancelar
          </button>
          <button
            onClick={handleApply}
            disabled={isApplying}
            className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold shadow-sm disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isApplying ? 'Aplicando...' : 'Aplicar (OK)'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

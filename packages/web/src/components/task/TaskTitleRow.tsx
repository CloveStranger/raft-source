import { Input, Button } from "raft-ui";
import { useCallback } from "react";
import { Trash2 } from "lucide-react";

export function TaskTitleRow({ index, title, placeholder, removable, onChange, onRemove }: {
  index: number;
  title: string;
  placeholder: string;
  removable: boolean;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onChange(index, e.target.value),
    [index, onChange],
  );
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);

  return (
    <div className="flex items-center gap-1 mb-1">
      <Input
        type="text"
        value={title}
        onChange={handleChange}
        className="w-full"
        placeholder={placeholder}
        autoFocus={index === 0}
      />
      {removable && (
        <Button size="sm"
          variant="danger"
          type="button"
          onClick={handleRemove}
          className="p-1"
        >
          <Trash2 size={14} />
        </Button>
      )}
    </div>
  );
}

import { Slider } from "@/components/ui/slider";

/** Wrapper around the shared `<Slider>` with the standard min/max/step used across
 *  media grids (100-400px, step 10). Views drop this into their toolbar without caring
 *  about the specific bounds. */
export function CoverSizeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-32 items-center gap-2">
      <Slider
        value={[value]}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        min={100}
        max={400}
        step={10}
        className="w-full"
      />
    </div>
  );
}
